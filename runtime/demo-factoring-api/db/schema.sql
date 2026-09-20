-- ファクタリング審査シナリオ用のデモ DB（factoring_demo）。
-- Agent Studio の DB とは別のデータベースに置く。業務データは Control Plane に入れない（CLAUDE.md「組織の分離」）。
-- 顧客の基幹システムに相当し、Agent からは demo-factoring-api の HTTP ツール経由でしか触れない。

DROP TABLE IF EXISTS screenings, payment_records, invoices, counterparties, applicants CASCADE;

-- 申込者（売掛金を資金化したい事業者）
CREATE TABLE applicants (
  id              text PRIMARY KEY,
  name            text        NOT NULL,
  representative  text        NOT NULL,
  address         text        NOT NULL,
  industry        text        NOT NULL,
  founded_on      date        NOT NULL,
  annual_revenue  bigint      NOT NULL,  -- 年商（円）
  employees       integer     NOT NULL,
  applied_on      date        NOT NULL,  -- 申込日
  note            text
);

-- 売掛先（債務者）。法人番号は申込書に書かれていないことがあるため NULL を許す
CREATE TABLE counterparties (
  id                text PRIMARY KEY,
  name              text        NOT NULL,
  address           text,
  corporate_number  char(13),            -- 申込書に記載があった法人番号。未記載は NULL
  note              text
);

-- 買取を申し込まれた請求書（債権）
CREATE TABLE invoices (
  id               text PRIMARY KEY,
  applicant_id     text        NOT NULL REFERENCES applicants(id),
  counterparty_id  text        NOT NULL REFERENCES counterparties(id),
  invoice_number   text        NOT NULL,  -- 申込者が発行した請求書番号
  issued_on        date        NOT NULL,
  due_on           date        NOT NULL,  -- 支払期日
  amount           bigint      NOT NULL,  -- 税込請求額（円）
  payment_terms    text        NOT NULL,
  status           text        NOT NULL DEFAULT '申込中',  -- 申込中 / 買取済 / 取下げ
  note             text
);

-- 売掛先からの過去の入金実績。予定どおり入っているかを見る
CREATE TABLE payment_records (
  id               bigserial PRIMARY KEY,
  applicant_id     text        NOT NULL REFERENCES applicants(id),
  counterparty_id  text        NOT NULL REFERENCES counterparties(id),
  invoice_number   text        NOT NULL,
  due_on           date        NOT NULL,
  paid_on          date,                  -- 未入金は NULL
  amount           bigint      NOT NULL
);

-- 審査結果の書き戻し。Agent はここに結果を残す
CREATE TABLE screenings (
  id                       bigserial PRIMARY KEY,
  invoice_id               text        NOT NULL REFERENCES invoices(id),
  decision                 text        NOT NULL,  -- 可 / 否 / 保留
  advance_rate             numeric(4,3),          -- 掛目（0.850 = 85%）
  fee_rate                 numeric(4,3),          -- 手数料率
  reason                   text        NOT NULL,
  verified_corporate_number char(13),             -- 実在確認で確認できた法人番号
  screened_by              text        NOT NULL DEFAULT 'agent',
  screened_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoices_applicant_idx ON invoices (applicant_id, status);
CREATE INDEX payment_records_counterparty_idx ON payment_records (counterparty_id, due_on);
CREATE INDEX screenings_invoice_idx ON screenings (invoice_id, screened_at DESC);
