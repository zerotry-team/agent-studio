"use client";

import type { MemberDto, MemberRole } from "@agent-studio/contracts";
import { inviteMemberSchema } from "@agent-studio/contracts";
import { UserPlus } from "lucide-react";
import { useId, useState } from "react";
import { inviteMemberAction } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Checkbox, Input } from "@/components/ui/input";
import { RadioCards } from "@/components/ui/radio-cards";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/utils/labels";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

export interface InviteMemberDialogProps {
  /** 付与できるロール（assignableRoles の結果） */
  roles: readonly MemberRole[];
  onClose: () => void;
  onInvited: (member: MemberDto) => void;
}

/** メンバーを招待するダイアログ（開くたびにマウントして、入力を空に戻す） */
export function InviteMemberDialog({ roles, onClose, onInvited }: InviteMemberDialogProps) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>(roles.includes("viewer") ? "viewer" : (roles[0] ?? "viewer"));
  const [isApprover, setIsApprover] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useActionMutation(inviteMemberAction, {
    successMessage: (m) => `${m.email} を招待しました`,
    onSuccess: (member) => {
      onInvited(member);
      onClose();
    },
  });

  const error = (path: string) => errors[path] ?? mutation.fieldErrors[path];

  const submit = async () => {
    const input = { email: email.trim(), role, is_approver: isApprover };
    const parsed = inviteMemberSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    await mutation.mutate(input);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={mutation.pending}
      title="メンバーを招待"
      description="招待したメールアドレスで Agent Studio にログインすると、この組織を使えるようになります。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={mutation.pending}
            icon={<UserPlus className="h-4 w-4" aria-hidden="true" />}
          >
            招待する
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Field label="メールアドレス" required error={error("email")}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            placeholder="name@example.com"
            data-autofocus
          />
        </Field>

        <RadioCards<MemberRole>
          legend="どの権限を付けますか？"
          description="あとから変更できます。"
          value={role}
          onChange={setRole}
          error={error("role")}
          options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] }))}
        />

        <Checkbox
          label="承認者にする"
          description="エージェントが承認の必要な操作をしようとしたとき、承認・却下できます。"
          checked={isApprover}
          onChange={(e) => setIsApprover(e.target.checked)}
        />
      </form>
    </Dialog>
  );
}
