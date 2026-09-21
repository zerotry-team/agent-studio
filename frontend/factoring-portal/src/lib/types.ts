export type ScreeningInput = {
  application_id: string;
  applicant: { corporate_number: string; company_name: string };
  counterparty: { corporate_number: string; company_name: string };
  requested_amount: number;
  invoice_amount: number;
  invoice_due_date: string;
  bank_statement_file_ids: string[];
  public_review_id: string;
};

export type PortalPhase = "received" | "checking" | "deciding" | "recording" | "complete" | "failed";

export type ScreeningView = {
  id: string;
  status: "running" | "completed" | "failed";
  phase: PortalPhase;
  progress: {
    received: boolean;
    documents: boolean;
    decision: boolean;
    recorded: boolean;
  };
  decision: string | null;
  decisionCode: string | null;
  reasonCodes: string[];
  ruleVersion: string | null;
  recorded: boolean;
  published: boolean;
  publicText: string | null;
  message: string | null;
};
