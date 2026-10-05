"""Tenant-isolated Argus model-v2 training and promotion evaluation."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Callable
import json
import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd


@dataclass(frozen=True)
class PromotionGate:
    promoted: bool
    improvement: float
    bias_delta: float
    coverage80: float
    reasons: list[str]


def classify_sku(values: pd.Series) -> str:
    values = values.clip(lower=0)
    if len(values) < 28: return "new"
    if not values.tail(28).gt(0).any(): return "inactive"
    nonzero = values[values.gt(0)]
    adi = len(values) / max(1, len(nonzero))
    cv2 = float(nonzero.var(ddof=0) / max(nonzero.mean() ** 2, 1e-9))
    return "lumpy" if adi >= 1.32 and cv2 >= .49 else "intermittent" if adi >= 1.32 else "regular"


def demand_features(frame: pd.DataFrame) -> pd.DataFrame:
    data = frame.sort_values(["sku", "date"]).copy()
    data["date"] = pd.to_datetime(data["date"], utc=True)
    for lag in (1, 7, 14, 28): data[f"lag_{lag}"] = data.groupby("sku")["quantity"].shift(lag)
    for window in (7, 14, 28): data[f"rolling_{window}"] = data.groupby("sku")["quantity"].transform(lambda x: x.shift(1).rolling(window).mean())
    data["dow"] = data.date.dt.dayofweek
    data["month"] = data.date.dt.month
    data["week"] = data.date.dt.isocalendar().week.astype(int)
    return data


def rolling_origins(dates: pd.Series, folds: int = 3, horizon_days: int = 14) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    maximum = pd.to_datetime(dates).max()
    return [(maximum - pd.Timedelta(days=horizon_days * fold), maximum - pd.Timedelta(days=horizon_days * (fold - 1))) for fold in range(folds, 0, -1)]


def metrics(actual: np.ndarray, predicted: np.ndarray, lower: np.ndarray, upper: np.ndarray) -> dict[str, float]:
    denominator = max(float(np.abs(actual).sum()), 1e-9)
    residual = actual - predicted
    naive_scale = max(float(np.abs(np.diff(actual)).mean()) if len(actual) > 1 else 1.0, 1e-9)
    return {
        "wape": float(np.abs(residual).sum() / denominator),
        "mase": float(np.abs(residual).mean() / naive_scale),
        "bias": float(residual.sum() / denominator),
        "pinball80": float(np.maximum(.8 * residual, -.2 * residual).mean()),
        "coverage80": float(((actual >= lower) & (actual <= upper)).mean()),
    }


def train_quantile_models(frame: pd.DataFrame, feature_columns: list[str], target: str) -> dict[str, lgb.LGBMRegressor]:
    models: dict[str, lgb.LGBMRegressor] = {}
    for name, alpha in (("lower", .1), ("median", .5), ("upper", .9)):
        model = lgb.LGBMRegressor(objective="quantile", alpha=alpha, n_estimators=400, learning_rate=.04, num_leaves=31, subsample=.8, colsample_bytree=.8, random_state=20260811)
        model.fit(frame[feature_columns], frame[target])
        models[name] = model
    return models


def evaluate_promotion(champion: dict[str, float], challenger: dict[str, float], replay: dict[str, float]) -> PromotionGate:
    improvement = (champion["wape"] - challenger["wape"]) / max(champion["wape"], 1e-9)
    reasons: list[str] = []
    if improvement < .05: reasons.append("Weighted error improvement is below 5%.")
    bias_delta = abs(challenger["bias"]) - abs(champion["bias"])
    if bias_delta > .02: reasons.append("Forecast bias materially worsened.")
    if abs(challenger["coverage80"] - .8) > .05: reasons.append("80% interval coverage is outside tolerance.")
    for metric in ("reserve_breaches", "excess_purchase", "stockout_exposure"):
        if replay.get(f"challenger_{metric}", 0) > replay.get(f"champion_{metric}", 0): reasons.append(f"Replay worsened {metric.replace('_', ' ')}.")
    return PromotionGate(not reasons, improvement, bias_delta, challenger["coverage80"], reasons)


def save_artifact(models: dict[str, object], metadata: dict, directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    artifact = directory / "model.joblib"; joblib.dump(models, artifact)
    checksum = sha256(artifact.read_bytes()).hexdigest()
    complete = {**metadata, "artifactChecksum": checksum, "status": "candidate"}
    (directory / "metadata.json").write_text(json.dumps(complete, indent=2), encoding="utf-8")
    return complete


if __name__ == "__main__":
    raise SystemExit("Import this module from the Cloud Run Job entrypoint with an immutable tenant snapshot.")
