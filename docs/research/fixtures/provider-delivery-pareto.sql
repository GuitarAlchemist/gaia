-- Reproducible advisory example. Replace ordinal scores with measured Gaia telemetry.
WITH options(task_class, provider, incremental_usd_month, quality,
             safe_parallel_lanes, github_native, setup_friction, security_risk) AS (
  VALUES
    ('closed_mechanics', 'Deterministic GitHub Actions', 0.0, 5.0, 8.0, 5.0, 2.0, 1.0),
    ('closed_mechanics', 'Claude Max local/wmux',        0.0, 3.0, 2.0, 1.0, 2.0, 2.0),
    ('closed_mechanics', 'GitHub Copilot Business',     19.0, 4.0, 4.0, 5.0, 1.0, 1.0),
    ('complex_code',     'Claude Max local/wmux',        0.0, 5.0, 2.0, 1.0, 2.0, 2.0),
    ('complex_code',     'Antigravity Gemini Flash',     0.0, 3.0, 1.0, 1.0, 4.0, 2.0),
    ('complex_code',     'Auggie existing credits',      0.0, 4.0, 1.0, 1.0, 4.0, 3.0),
    ('complex_code',     'GitHub Copilot Business',     19.0, 4.5, 4.0, 5.0, 1.0, 1.0)
), frontier AS (
  SELECT candidate.*
  FROM options AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM options AS rival
    WHERE rival.task_class = candidate.task_class
      AND rival.provider <> candidate.provider
      AND rival.incremental_usd_month <= candidate.incremental_usd_month
      AND rival.quality >= candidate.quality
      AND rival.safe_parallel_lanes >= candidate.safe_parallel_lanes
      AND rival.github_native >= candidate.github_native
      AND rival.setup_friction <= candidate.setup_friction
      AND rival.security_risk <= candidate.security_risk
      AND (rival.incremental_usd_month < candidate.incremental_usd_month
        OR rival.quality > candidate.quality
        OR rival.safe_parallel_lanes > candidate.safe_parallel_lanes
        OR rival.github_native > candidate.github_native
        OR rival.setup_friction < candidate.setup_friction
        OR rival.security_risk < candidate.security_risk)
  )
)
SELECT * FROM frontier ORDER BY task_class, incremental_usd_month, provider;
