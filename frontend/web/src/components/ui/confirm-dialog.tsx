"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { Field } from "./field";
import { Input } from "./input";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** 実行する処理。完了するまでボタンは押せない。false を返すとダイアログを閉じない */
  onConfirm: () => Promise<unknown> | unknown;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** 取り消せない操作では、確認のためにこの文字列を入力してもらう */
  confirmText?: string;
}

/** 削除・失効など、取り消せない操作の確認ダイアログ */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = "実行する",
  cancelLabel = "キャンセル",
  tone = "danger",
  confirmText,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      setTyped("");
      setPending(false);
    }
  }, [open]);

  const blocked = !!confirmText && typed.trim() !== confirmText;

  const handleConfirm = async () => {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={pending}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={handleConfirm} loading={pending} disabled={blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children || confirmText ? (
        <div className="space-y-4">
          {children}
          {confirmText ? (
            <Field
              label={
                <span>
                  確認のため <span className="font-mono font-semibold">{confirmText}</span> と入力してください
                </span>
              }
            >
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
            </Field>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
