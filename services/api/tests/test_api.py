from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_seeded_analysis_contract_and_tenant_isolation():
    created = client.post("/v1/analysis-runs", json={"use_seeded_demo": True}, headers={"x-business-id": "business-a"})
    assert created.status_code == 200
    run_id = created.json()["id"]
    result = client.get(f"/v1/analysis-runs/{run_id}", headers={"x-business-id": "business-a"})
    assert result.status_code == 200
    payload = result.json()
    assert len(payload["actions"]) == 3
    assert payload["verifier"]["passed"] is True
    denied = client.get(f"/v1/analysis-runs/{run_id}", headers={"x-business-id": "business-b"})
    assert denied.status_code == 404


def test_upload_validation_blocks_missing_columns():
    response = client.post(
        "/v1/uploads/sales",
        files={"file": ("bad.csv", b"date,sku\n2026-08-08,A\n", "text/csv")},
    )
    assert response.status_code == 200
    assert response.json()["analysis_ready"] is False
    assert response.json()["critical_errors"]


def test_relationship_approval_never_sends_automatically():
    client.post("/v1/analysis-runs", json={"use_seeded_demo": True}, headers={"x-business-id": "approval-test"})
    response = client.post("/v1/actions/collect-sharma/approve", json={"relationship_action": "payment-date"}, headers={"x-business-id": "approval-test"})
    assert response.status_code == 200
    assert response.json()["approved"] is True
    assert response.json()["sent"] is False
    assert response.json()["whatsapp_deep_link"].startswith("https://wa.me/")


def test_outcome_requires_owner_approval():
    response = client.post("/v1/outcomes", json={"action_id": "unknown", "outcome_type": "other", "amount": 0}, headers={"x-business-id": "outcome-test"})
    assert response.status_code == 409
