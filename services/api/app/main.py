from __future__ import annotations

import os
import urllib.parse
from collections import defaultdict

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .engine import parse_table, seeded_analysis, validate_table
from .gemini import GeminiAdapter
from .models import AnalysisRequest, ApprovalRequest, OutcomeRequest, QualityReport, SimulationRequest

app = FastAPI(title="Argus Working Capital Copilot", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

uploads: dict[str, dict[str, list[dict]]] = defaultdict(dict)
runs = {}
outcomes: list[dict] = []
approvals: set[tuple[str, str]] = set()
column_mappings: dict[str, dict] = {}
gemini = GeminiAdapter()


def business_id(value: str | None) -> str:
    return value or "demo-electricals"


@app.get("/health")
def health():
    return {"status": "ok", "gemini": "configured" if gemini.configured else "deterministic-fallback"}


@app.post("/v1/uploads/{dataset_type}", response_model=QualityReport)
async def upload_dataset(dataset_type: str, file: UploadFile = File(...), x_business_id: str | None = Header(default=None)):
    if dataset_type not in {"sales", "inventory", "receivables", "suppliers", "cash_obligations"}:
        raise HTTPException(400, "Unsupported dataset type")
    content = await file.read()
    try:
        frame = parse_table(file.filename or "upload.csv", content)
    except Exception as exc:
        raise HTTPException(422, f"Could not parse upload: {exc}") from exc
    report = validate_table(dataset_type, frame)
    if report["analysis_ready"]:
        uploads[business_id(x_business_id)][dataset_type] = frame.drop_duplicates().to_dict(orient="records")
    return QualityReport(**report)


@app.post("/v1/column-mappings")
def save_mapping(mapping: dict, x_business_id: str | None = Header(default=None)):
    column_mappings[business_id(x_business_id)] = mapping
    return {"saved": True, "business_id": business_id(x_business_id)}


@app.post("/v1/analysis-runs")
def create_analysis(request: AnalysisRequest, x_business_id: str | None = Header(default=None)):
    result = seeded_analysis(request.settings)
    fallback = "Inventory demand supports replenishment, while the cash constraint requires a partial order. Collect the strategic receivable using an owner-selected tone, then fund the deferred quantity. Pause slow-moving stock purchasing. Every external action requires human approval."
    explanation, mode = gemini.explain({
        "snapshot_id": result.snapshot_id,
        "specialist_assessments": [item.model_dump() for item in result.assessments],
        "verified_actions": [item.model_dump() for item in result.actions],
        "optimizer": result.optimizer,
    }, fallback)
    result.verifier["moderator_explanation"] = explanation
    result.verifier["reasoning_mode"] = mode
    runs[result.id] = {"business_id": business_id(x_business_id), "result": result}
    return {"id": result.id, "status": result.status, "snapshot_id": result.snapshot_id}


@app.get("/v1/analysis-runs/{run_id}")
def get_analysis(run_id: str, x_business_id: str | None = Header(default=None)):
    stored = runs.get(run_id)
    if not stored or stored["business_id"] != business_id(x_business_id):
        raise HTTPException(404, "Analysis run not found")
    return stored["result"]


@app.get("/v1/analysis-runs/{run_id}/actions")
def get_actions(run_id: str, x_business_id: str | None = Header(default=None)):
    return {"actions": get_analysis(run_id, x_business_id).actions}


@app.post("/v1/simulations")
def simulate(request: SimulationRequest, x_business_id: str | None = Header(default=None)):
    stored = get_analysis(request.analysis_run_id, x_business_id)
    allocation = next(item for item in stored.optimizer["allocations"] if item["sku"] == "SWITCH-A")
    budget = request.purchasing_budget or stored.optimizer["spendable_budget"]
    cash_capacity = max(0, budget + request.payment_received)
    required = int(round(allocation["unconstrained_quantity"] * request.demand_multiplier / 10) * 10)
    affordable = min(required, int(cash_capacity // 800 // 10 * 10))
    return {"source_run_id": request.analysis_run_id, "mutated": False, "switch_a": {"required_units": required, "affordable_units": affordable, "deferred_units": required - affordable}, "purchasing_capacity": cash_capacity}


@app.post("/v1/actions/{action_id}/approve")
def approve_action(action_id: str, request: ApprovalRequest, x_business_id: str | None = Header(default=None)):
    tenant = business_id(x_business_id)
    action = next((item for stored in runs.values() if stored["business_id"] == tenant for item in stored["result"].actions if item.id == action_id), None)
    if action is None:
        raise HTTPException(409, "Action is not part of a verified analysis")
    if action.action_type == "collection" and request.relationship_action is None:
        raise HTTPException(400, "Choose a relationship-aware collection approach first")
    approvals.add((tenant, action_id))
    message = f"Hello, could you please confirm the expected payment date for the outstanding amount of â‚¹{action.financial_amount:,.0f}? This will help us schedule upcoming supply orders. Please let us know if you need any clarification from our side."
    return {"action_id": action_id, "approved": True, "sent": False, "relationship_action": request.relationship_action, "draft": message if action.action_type == "collection" else None, "whatsapp_deep_link": f"https://wa.me/?text={urllib.parse.quote(message)}" if action.action_type == "collection" else None}


@app.post("/v1/outcomes")
def record_outcome(request: OutcomeRequest, x_business_id: str | None = Header(default=None)):
    tenant = business_id(x_business_id)
    if (tenant, request.action_id) not in approvals:
        raise HTTPException(409, "Record owner approval before recording an outcome")
    item = {"business_id": tenant, **request.model_dump()}
    outcomes.append(item)
    return {"recorded": True, "outcome": item}


@app.get("/v1/weekly-summary")
def weekly_summary(x_business_id: str | None = Header(default=None)):
    relevant = [o for o in outcomes if o["business_id"] == business_id(x_business_id)]
    return {"outcomes_recorded": len(relevant), "measured_amount": sum(o["amount"] for o in relevant), "stockout_risks_addressed": sum(o["outcome_type"] == "stockout_avoided" for o in relevant), "autonomous_actions": 0}
