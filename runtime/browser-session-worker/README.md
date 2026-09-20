# Browser Session Worker

Agent Studio のRunごとに1つ起動する、状態を保持するChromium / Playwright MCP Workerです。

- `BROWSER_ALLOWED_DOMAINS` とURL policyの両方で遷移を制限します。
- Private IP、link-local、metadata endpoint、直接IPを拒否します。
- endpointは `/mcp/<session token>` で、Runtime CoreのSecurity Groupからだけ到達できます。
- `authenticated_restricted` では `browser_exec_js` を公開しません。
- Screenshotのbase64はMCPレスポンスだけに含め、ログへ出しません。
- SIGTERMでBrowser Contextを閉じます。

実ネットワークの強制境界（Egress Proxy）はPhase 2で追加します。アプリ側policyだけを最終的な境界として扱わないでください。
