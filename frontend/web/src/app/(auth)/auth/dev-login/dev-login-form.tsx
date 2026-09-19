"use client";

import { useFormState, useFormStatus } from "react-dom";
import { devLoginAction, type DevLoginState } from "@/actions/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" loading={pending}>
      ログイン
    </Button>
  );
}

export function DevLoginForm({ next }: { next: string }) {
  const [state, formAction] = useFormState<DevLoginState, FormData>(devLoginAction, {});
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <input type="hidden" name="next" value={next} />
      <Field label="メールアドレス" required>
        <Input name="email" type="email" autoComplete="email" placeholder="admin@sample-a.example" autoFocus />
      </Field>
      <SubmitButton />
    </form>
  );
}
