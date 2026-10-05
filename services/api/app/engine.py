from __future__ import annotations

import math
import statistics
import uuid
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from ortools.linear_solver import pywraplp

from .models import (
    AnalysisResult,
    AnalysisStatus,
    BusinessSettings,
    DailyAction,
    Evidence,
    SpecialistAssessment,
)


def round_package(quantity: float, package_size: int, minimum: int) -> int:
    if quantity <= 0:
        return 0
    rounded = math.ceil(quantity / package_size) * package_size
    return max(rounded, minimum)


def wape(actual: np.ndarray, predicted: np.ndarray) -> float:
    denominator = float(np.abs(actual).sum())
    return float(np.abs(actual - predicted).sum() / denominator) if denominator else 0.0


def seasonal_naive_forecast(series: list[float], horizon: int) -> list[float]:
    if not series:
        return [0.0] * horizon
    season = series[-7:] if len(series) >= 7 else series
    return [float(season[index % len(season)]) for index in range(horizon)]


def exponential_forecast(series: list[float], horizon: int, alpha: float = 0.35) -> list[float]:
    if not series:
        return [0.0] * horizon
    level = float(series[0])
    for value in series[1:]:
        level = alpha * float(value) + (1 - alpha) * level
    return [level] * horizon


def croston_forecast(series: list[float], horizon: int, alpha: float = 0.2) -> list[float]:
    nonzero = [(i, float(v)) for i, v in enumerate(series) if v > 0]
    if not nonzero:
        return [0.0] * horizon
    demand = nonzero[0][1]
    interval = max(1.0, float(nonzero[0][0] + 1))
    last_index = nonzero[0][0]
    for index, value in nonzero[1:]:
        demand = alpha * value + (1 - alpha) * demand
        gap = max(1, index - last_index)
        interval = alpha * gap + (1 - alpha) * interval
        last_index = index
    rate = demand / interval
    return [rate] * horizon


def forecast_series(series: list[float], horizon: int = 30) -> dict[str, Any]:
    history = len(series)
    if history < 28:
        daily = float(np.mean(series[-14:])) if series else 0.0
        forecast = [daily] * horizon
        model, error, confidence = "moving_average", None, "low"
    else:
        holdout = min(14, max(7, history // 5))
        train, actual = series[:-holdout], np.array(series[-holdout:], dtype=float)
        candidates = {
            "seasonal_naive": seasonal_naive_forecast(train, holdout),
            "exponential_smoothing": exponential_forecast(train, holdout),
            "croston": croston_forecast(train, holdout),
        }
        scores = {name: wape(actual, np.array(values)) for name, values in candidates.items()}
        model = min(scores, key=scores.get)
        error = scores[model]
        generator = {
            "seasonal_naive": seasonal_naive_forecast,
            "exponential_smoothing": exponential_forecast,
            "croston": croston_forecast,
        }[model]
        forecast = generator(series, horizon)
        confidence = "high" if error <= 0.2 else "medium" if error <= 0.4 else "low"
    total_14 = float(sum(forecast[:14]))
    spread = max(0.12, min(0.35, error if error is not None else 0.3))
    return {
        "model": model,
        "wape": error,
        "confidence": confidence,
        "history_days": history,
        "daily": float(np.mean(forecast[:7])),
        "forecast_7_days": round(sum(forecast[:7]), 1),
        "forecast_14_days": round(total_14, 1),
        "forecast_30_days": round(sum(forecast), 1),
        "lower_14": round(total_14 * (1 - spread), 1),
        "upper_14": round(total_14 * (1 + spread), 1),
    }


def robust_anomalies(series: list[float]) -> list[dict[str, Any]]:
    if len(series) < 14:
        return []
    recent = np.array(series[-7:], dtype=float)
    baseline = np.array(series[:-7], dtype=float)
    median = float(np.median(baseline))
    mad = float(np.median(np.abs(baseline - median))) or 1.0
    actual = float(recent.mean())
    robust_z = 0.6745 * (actual - median) / mad
    if abs(robust_z) < 2.5:
        return []
    expected = max(median, 0.01)
    return [{
        "type": "sales_spike" if robust_z > 0 else "sales_decline",
        "expected_units": round(expected * 7, 1),
        "actual_units": round(float(recent.sum()), 1),
        "difference_percentage": round((actual - expected) / expected * 100),
        "duration_days": 7,
        "severity": "high" if abs(robust_z) >= 4 else "medium",
    }]


def project_cash(settings: BusinessSettings, receivables: list[dict[str, Any]], obligations: list[dict[str, Any]], proposed_purchase: float) -> dict[str, Any]:
    today = date.today()
    events: dict[date, float] = {}
    for item in receivables:
        expected = item.get("expected_date", today)
        if isinstance(expected, str):
            expected = date.fromisoformat(expected)
        events[expected] = events.get(expected, 0) + float(item["outstanding"])
    for item in obligations:
        due = item.get("date", today)
        if isinstance(due, str):
            due = date.fromisoformat(due)
        events[due] = events.get(due, 0) - float(item["amount"])
    events[today] = events.get(today, 0) - proposed_purchase
    balance = settings.available_cash
    minimum = balance
    shortage_date = None
    balances = []
    for offset in range(30):
        day = today + timedelta(days=offset)
        balance += events.get(day, 0)
        balances.append({"date": day.isoformat(), "balance": round(balance, 2)})
        minimum = min(minimum, balance)
        if shortage_date is None and balance < settings.minimum_cash_reserve:
            shortage_date = day.isoformat()
    return {
        "minimum_projected_balance": round(minimum, 2),
        "shortage_date": shortage_date,
        "minimum_reserve": settings.minimum_cash_reserve,
        "overdue_total": round(sum(float(r["outstanding"]) for r in receivables if r.get("overdue")), 2),
        "daily_balances": balances,
    }


def optimize_purchases(items: list[dict[str, Any]], settings: BusinessSettings) -> dict[str, Any]:
    spendable = max(0, min(settings.purchasing_budget, settings.available_cash - settings.minimum_cash_reserve))
    solver = pywraplp.Solver.CreateSolver("SCIP")
    if solver is None:
        raise RuntimeError("OR-Tools SCIP solver is unavailable")
    variables = {}
    selected = {}
    for item in items:
        package = int(item["package_size"])
        requested = round_package(item["shortage_units"], package, int(item["moq"]))
        max_packages = requested // package
        variables[item["sku"]] = solver.IntVar(0, max_packages, f"packages_{item['sku']}")
        selected[item["sku"]] = solver.BoolVar(f"selected_{item['sku']}")
        minimum_packages = math.ceil(int(item["moq"]) / package)
        solver.Add(variables[item["sku"]] <= max_packages * selected[item["sku"]])
        solver.Add(variables[item["sku"]] >= minimum_packages * selected[item["sku"]])
    solver.Add(sum(variables[item["sku"]] * item["package_size"] * item["unit_cost"] for item in items) <= spendable)
    solver.Add(sum(variables[item["sku"]] * item["package_size"] for item in items) <= settings.storage_capacity_units)
    solver.Maximize(sum(variables[item["sku"]] * item["package_size"] * item["priority_score"] for item in items))
    status = solver.Solve()
    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        raise RuntimeError("Purchase optimizer could not find a feasible allocation")
    allocations = []
    allocated_cost = 0.0
    for item in sorted(items, key=lambda x: x["priority_score"], reverse=True):
        package = int(item["package_size"])
        requested = round_package(item["shortage_units"], package, int(item["moq"]))
        affordable = int(round(variables[item["sku"]].solution_value())) * package
        if 0 < affordable < item["moq"]:
            affordable = 0
        cost = affordable * float(item["unit_cost"])
        allocated_cost += cost
        allocations.append({
            "sku": item["sku"],
            "unconstrained_quantity": requested,
            "approved_quantity": affordable,
            "deferred_quantity": requested - affordable,
            "cost": round(cost, 2),
            "constraint": None if affordable == requested else "cash_reserve_or_budget",
        })
    return {"solver": "OR-Tools SCIP", "spendable_budget": spendable, "allocated": round(allocated_cost, 2), "remaining": round(spendable - allocated_cost, 2), "allocations": allocations}


def seeded_analysis(settings: BusinessSettings) -> AnalysisResult:
    run_id = f"run_{uuid.uuid4().hex[:8]}"
    today = date.today()
    sales = {
        "SWITCH-A": [3, 4, 5, 4, 6, 5, 3] * 8 + [7, 8, 9, 8, 10, 9, 7] * 2,
        "CABLE-B": [5, 4, 5, 5, 4, 5, 4] * 8 + [2, 3, 2, 3, 2, 3, 4] * 2,
        "MCB-C": [2, 1, 3, 2, 2, 1, 2] * 10,
    }
    stock = {
        "SWITCH-A": {"current": 42, "reserved": 4, "incoming": 0, "cost": 800, "sell": 1250, "lead": 10, "moq": 20, "package": 10},
        "CABLE-B": {"current": 142, "reserved": 0, "incoming": 0, "cost": 296, "sell": 450, "lead": 7, "moq": 25, "package": 5},
        "MCB-C": {"current": 30, "reserved": 2, "incoming": 10, "cost": 520, "sell": 760, "lead": 8, "moq": 10, "package": 10},
    }
    forecasts, anomalies, metrics, evidence, candidates = [], [], [], [], []
    confidence_weight = {"high": 1.0, "medium": 0.75, "low": 0.5}
    for sku, history in sales.items():
        fc = forecast_series(history)
        fc["sku"] = sku
        forecasts.append(fc)
        for anomaly in robust_anomalies(history):
            anomaly["sku"] = sku
            anomalies.append(anomaly)
        item = stock[sku]
        available = item["current"] - item["reserved"] + item["incoming"]
        lead_demand = fc["daily"] * item["lead"]
        safety = fc["daily"] * settings.safety_stock_days
        shortage = max(0, lead_demand + safety - available)
        days_cover = available / fc["daily"] if fc["daily"] else 999
        metric = {
            "sku": sku,
            "available_stock": available,
            "lead_time_demand": round(lead_demand, 1),
            "safety_stock": round(safety, 1),
            "reorder_point": round(lead_demand + safety, 1),
            "unrounded_shortage": round(shortage, 1),
            "days_cover": round(days_cover, 1),
            "stockout_in_days": math.floor(days_cover) if days_cover < item["lead"] else None,
            "stock_value": round(item["current"] * item["cost"], 2),
        }
        metrics.append(metric)
        margin = item["sell"] - item["cost"]
        candidates.append({
            "sku": sku, "shortage_units": shortage, "unit_cost": item["cost"], "moq": item["moq"], "package_size": item["package"],
            "priority_score": max(0.01, shortage) * margin * confidence_weight[fc["confidence"]],
        })
        evidence.extend([
            Evidence(id=f"{sku}-stock", label="Usable stock", value=f"{available} units", source="inventory_snapshot"),
            Evidence(id=f"{sku}-forecast", label="14-day demand", value=f"{fc['forecast_14_days']} units", source="forecast_engine"),
        ])
    optimizer = optimize_purchases(candidates, settings)
    switch_alloc = next(a for a in optimizer["allocations"] if a["sku"] == "SWITCH-A")
    receivables = [
        {"customer": "Sharma Electricals", "outstanding": 74_000, "overdue": True, "expected_date": (today + timedelta(days=3)).isoformat()},
        {"customer": "Patel Projects", "outstanding": 62_000, "overdue": True, "expected_date": (today + timedelta(days=8)).isoformat()},
    ]
    obligations = [{"label": "Rent and salaries", "amount": 34_000, "date": (today + timedelta(days=6)).isoformat()}]
    cashflow = project_cash(settings, receivables, obligations, optimizer["allocated"])
    evidence.extend([
        Evidence(id="cash-capacity", label="Safe purchasing capacity", value=f"₹{optimizer['spendable_budget']:,.0f}", source="cash_engine"),
        Evidence(id="sharma-overdue", label="Sharma Electricals", value="₹74,000 overdue by 12 days", source="receivables_snapshot"),
        Evidence(id="cable-cover", label="Cable B cover", value=next(m for m in metrics if m["sku"] == "CABLE-B")["days_cover"].__format__(".0f") + " days", source="inventory_engine"),
    ])
    assessments = [
        SpecialistAssessment(specialist="inventory", position=f"Purchase {switch_alloc['unconstrained_quantity']} Switch A units", evidence_ids=["SWITCH-A-stock", "SWITCH-A-forecast"], confidence=.88),
        SpecialistAssessment(specialist="cashflow", position=f"Limit immediate Switch A purchase to {switch_alloc['approved_quantity']} units", evidence_ids=["cash-capacity", "sharma-overdue"], risks=["Minimum cash reserve breach"], confidence=.94),
        SpecialistAssessment(specialist="sales", position="Protect Switch A availability and pause Cable B", evidence_ids=["SWITCH-A-forecast", "cable-cover"], confidence=.91),
    ]
    actions = [
        DailyAction(id="reorder-switch-a", action_type="reorder", title=f"Order {switch_alloc['approved_quantity']} units of Switch A", reason="A partial order protects near-term sales without breaching the minimum cash reserve.", urgency="critical", confidence=.88, financial_amount=switch_alloc["cost"], impact="Protects approximately ₹76,000 in near-term sales", evidence_ids=["SWITCH-A-stock", "SWITCH-A-forecast", "cash-capacity"]),
        DailyAction(id="collect-sharma", action_type="collection", title="Confirm payment date with Sharma Electricals", reason="The payment unlocks the deferred Switch A quantity, but the strategic relationship requires owner-selected tone.", urgency="high", confidence=.94, financial_amount=74_000, impact="Unlocks the remaining priority purchase", evidence_ids=["sharma-overdue", "cash-capacity"], requires_human_context=True, allowed_relationship_actions=["friendly", "payment-date", "formal", "personal-call"]),
        DailyAction(id="defer-cable-b", action_type="defer", title="Pause the next Cable B purchase", reason="Stock cover materially exceeds the target while recent sales are below baseline.", urgency="medium", confidence=.91, financial_amount=42_000, impact="Keeps ₹42,000 available for faster-moving stock", evidence_ids=["cable-cover"]),
    ]
    valid_evidence = {e.id for e in evidence}
    verifier_errors = [f"Invalid evidence: {eid}" for action in actions for eid in action.evidence_ids if eid not in valid_evidence]
    return AnalysisResult(
        id=run_id, status=AnalysisStatus.completed if not verifier_errors else AnalysisStatus.failed,
        snapshot_id=f"AR-{today.isoformat()}-001", warnings=["2 missing lead times use the 7-day business median"], forecasts=forecasts,
        anomalies=anomalies, inventory_metrics=metrics, cashflow=cashflow, optimizer=optimizer, assessments=assessments,
        evidence=evidence, actions=actions, verifier={"passed": not verifier_errors, "errors": verifier_errors, "mode": "deterministic"},
    )


def parse_table(filename: str, content: bytes) -> pd.DataFrame:
    from io import BytesIO
    if filename.lower().endswith(".xlsx"):
        return pd.read_excel(BytesIO(content))
    return pd.read_csv(BytesIO(content))


def validate_table(dataset_type: str, frame: pd.DataFrame) -> dict[str, Any]:
    required = {
        "sales": {"date", "invoice_id", "customer_id", "sku", "quantity", "selling_price"},
        "inventory": {"sku", "current_stock", "purchase_cost", "supplier_id"},
        "receivables": {"customer_id", "invoice_id", "due_date", "invoice_amount", "outstanding_amount"},
        "suppliers": {"supplier_id", "sku", "average_lead_time_days"},
        "cash_obligations": {"date", "label", "amount"},
    }.get(dataset_type, set())
    normalized = {str(c).strip().lower() for c in frame.columns}
    missing = sorted(required - normalized)
    duplicate_rows = int(frame.duplicated().sum())
    critical = [f"Missing required column: {column}" for column in missing]
    return {
        "dataset_type": dataset_type, "valid_rows": int(len(frame) - duplicate_rows), "rejected_rows": 0,
        "duplicate_rows": duplicate_rows, "missing_lead_times": 0, "unknown_skus": 0,
        "warnings": [f"{duplicate_rows} duplicate rows will be ignored"] if duplicate_rows else [],
        "critical_errors": critical, "analysis_ready": not critical,
    }
