from datetime import date, timedelta

from app.engine import forecast_series, optimize_purchases, project_cash, robust_anomalies, round_package, seeded_analysis
from app.models import BusinessSettings


def test_package_rounding_respects_moq():
    assert round_package(12, 10, 20) == 20
    assert round_package(21, 10, 20) == 30
    assert round_package(0, 10, 20) == 0


def test_low_history_forecast_is_low_confidence():
    result = forecast_series([2, 3, 4] * 5)
    assert result["model"] == "moving_average"
    assert result["confidence"] == "low"


def test_anomaly_detects_recent_decline():
    result = robust_anomalies([10] * 30 + [2] * 7)
    assert result and result[0]["type"] == "sales_decline"


def test_optimizer_never_spends_reserve():
    settings = BusinessSettings(available_cash=100_000, minimum_cash_reserve=70_000, purchasing_budget=90_000)
    result = optimize_purchases([{"sku": "A", "shortage_units": 100, "unit_cost": 800, "moq": 20, "package_size": 10, "priority_score": 100}], settings)
    assert result["allocated"] <= 30_000
    assert result["remaining"] >= 0


def test_cash_projection_reports_reserve_breach():
    settings = BusinessSettings(available_cash=100_000, minimum_cash_reserve=70_000, purchasing_budget=90_000)
    result = project_cash(settings, [], [{"date": date.today().isoformat(), "amount": 40_000}], 0)
    assert result["shortage_date"] == date.today().isoformat()


def test_seeded_analysis_is_verified_and_relationship_aware():
    result = seeded_analysis(BusinessSettings())
    assert result.verifier["passed"] is True
    assert len(result.actions) == 3
    collection = next(action for action in result.actions if action.action_type == "collection")
    assert collection.requires_human_context is True
    assert "personal-call" in collection.allowed_relationship_actions
