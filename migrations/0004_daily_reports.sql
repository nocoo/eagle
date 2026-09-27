CREATE TABLE machine_daily_reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(machine_id, date)
);
CREATE INDEX machine_daily_date ON machine_daily_reports(date DESC, seq DESC);
CREATE INDEX machine_daily_machine ON machine_daily_reports(machine_id, date DESC, seq DESC);
DROP TABLE machine_hour_reports;
