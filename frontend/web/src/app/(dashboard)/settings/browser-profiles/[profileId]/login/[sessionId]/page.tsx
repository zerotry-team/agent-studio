"use client";

import { ArrowLeft, CheckCircle2, Keyboard, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cancelBrowserLoginAction, getBrowserLoginAction, issueBrowserRelayTicketAction } from "@/actions/browser-profiles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { unwrapAction } from "@/hooks/action-client";

type RelayMessage = { type: string; image?: string; url?: string; title?: string; message?: string };

export default function BrowserLoginPage() {
  const params = useParams<{ profileId: string; sessionId: string }>();
  const sessionId = params.sessionId;
  const socket = useRef<WebSocket | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const terminal = useRef(false);
  const [frame, setFrame] = useState<{ image: string; url: string; title: string } | null>(null);
  const [status, setStatus] = useState("RuntimeのBrowserを準備しています");
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [url, setUrl] = useState("");
  const [completed, setCompleted] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const connect = async () => {
      try {
        const ticket = await unwrapAction(issueBrowserRelayTicketAction(sessionId));
        if (disposed || terminal.current) return;
        const ws = new WebSocket(ticket.websocket_url);
        socket.current = ws;
        ws.onopen = () => { attempt = 0; setError(null); ws.send(JSON.stringify({ type: "auth", role: "user", session_id: sessionId, token: ticket.token })); };
        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          let message: RelayMessage;
          try { message = JSON.parse(event.data) as RelayMessage; } catch { return; }
          if (message.type === "paired") setStatus("接続済み。画面上でログインしてください");
          else if (message.type === "waiting") setStatus("RuntimeのBrowserを待っています");
          else if (message.type === "frame" && message.image && message.url !== undefined && message.title !== undefined) {
            setFrame({ image: message.image, url: message.url, title: message.title }); setUrl(message.url); setError(null);
          } else if (message.type === "completed") { terminal.current = true; setCompleted(true); setStatus("ログイン状態を保存しました"); }
          else if (message.type === "error") setError(message.message ?? "Browser操作に失敗しました");
        };
        ws.onerror = () => setError("Human Login Relayとの接続が切れました。自動再接続します");
        ws.onclose = () => {
          if (disposed || terminal.current) return;
          attempt++;
          setStatus("Human Login Relayへ再接続しています");
          reconnect = setTimeout(() => void connect(), Math.min(5_000, 500 * 2 ** Math.min(attempt, 4)));
        };
      } catch (reason) {
        if (!disposed && !terminal.current) {
          setError(reason instanceof Error ? reason.message : "Human Loginを開始できませんでした");
          reconnect = setTimeout(() => void connect(), 2_000);
        }
      }
    };
    void connect();
    return () => { disposed = true; if (reconnect) clearTimeout(reconnect); socket.current?.close(); };
  }, [sessionId]);

  useEffect(() => {
    if (completed || cancelled) return;
    const timer = setInterval(() => {
      void unwrapAction(getBrowserLoginAction(sessionId)).then((session) => {
        if (session.status === "succeeded") { setCompleted(true); setStatus("ログイン状態を保存しました"); }
        else if (["failed", "cancelled", "expired"].includes(session.status)) setError(session.error ?? `Human Loginは${session.status}になりました`);
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [cancelled, completed, sessionId]);

  const send = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };
  const click = (event: React.MouseEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const naturalWidth = image.current?.naturalWidth || 1440;
    const naturalHeight = image.current?.naturalHeight || 900;
    send({ type: "click", x: (event.clientX - bounds.left) * naturalWidth / bounds.width, y: (event.clientY - bounds.top) * naturalHeight / bounds.height });
  };
  const type = () => { if (value) { send({ type: "type", value }); setValue(""); } };
  const cancel = async () => {
    send({ type: "cancel" });
    try {
      await unwrapAction(cancelBrowserLoginAction(sessionId));
      terminal.current = true;
      socket.current?.close();
      setCancelled(true);
      setError(null);
      setStatus("中止済み");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Human Loginを中止できませんでした");
    }
  };

  return (
    <div className="space-y-6">
      <Link href="/settings?tab=infrastructure" className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"><ArrowLeft className="h-4 w-4" />実行・開発基盤へ戻る</Link>
      <Card>
        <CardHeader title="Human Login" description="この15分間だけ、あなたの操作を自社RuntimeのBrowserへ中継します。入力内容・Cookie・ScreenshotをAgent StudioのDBやログへ保存しません。" />
        <CardBody className="space-y-4">
          {completed ? <Alert tone="success" title="接続が完了しました"><span className="inline-flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />待機中のAgent Builderは自動的に再開します。</span></Alert> : cancelled ? <Alert tone="warning">Human Loginを中止しました。</Alert> : <Alert tone="info"><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{status}</span></Alert>}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!completed && !cancelled ? <>
            <div className="flex gap-2"><Input value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" aria-label="開くURL" /><Button variant="secondary" onClick={() => send({ type: "navigate", url })}>開く</Button></div>
            <div className="overflow-hidden rounded-lg border border-gray-300 bg-gray-950">
              {/* Runtimeから届く短命なdata URLであり、Next Imageの最適化対象にしない。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {frame ? <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title || "ログイン画面"} onClick={click} className="block h-auto w-full cursor-crosshair" draggable={false} /> : <div className="flex aspect-[16/10] items-center justify-center text-sm text-gray-400">Browser画面を待っています</div>}
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
              <Input type="password" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); type(); } }} placeholder="選択中の欄へ入力（送信後に消去）" autoComplete="new-password" aria-label="Browserへ秘密入力" />
              <Button onClick={type} icon={<Keyboard className="h-4 w-4" />}>入力</Button>
              <Button variant="secondary" onClick={() => send({ type: "key", key: "Tab" })}>Tab</Button>
              <Button variant="secondary" onClick={() => send({ type: "key", key: "Enter" })}>Enter</Button>
            </div>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => void cancel()}>中止</Button><Button onClick={() => send({ type: "complete" })}>ログイン完了・状態を保存</Button></div>
          </> : null}
        </CardBody>
      </Card>
    </div>
  );
}
