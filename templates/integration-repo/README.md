# Agent Studio Integrations

Agent Studio の Builder Agent が作る、この組織専用の社内システム用 Adapter のリポジトリです。

1. Agent Studio で Agent を作るとき、使える Tool が無ければ Builder がここに `builder/*` branch で Adapter を追加し、PR を作ります
2. CI（`agent-studio / check`）が形式・依存・秘密情報・テストを検査します
3. main へ merge すると CI（`agent-studio / deliver`）が Adapter を署名して Release に添付し、Deployment を作ります
4. Agent Studio が署名を確かめ、Runtime が Adapter を導入して Tool として使えるようになります

作り方の決まりは [AGENTS.md](AGENTS.md)、Runtime から渡る値は [RUNTIME.md](RUNTIME.md) にあります。

必要な GitHub Actions の secret: `ADAPTER_SIGNING_KEY`（Ed25519 の秘密鍵。`agent-studio github connect` が登録します）
