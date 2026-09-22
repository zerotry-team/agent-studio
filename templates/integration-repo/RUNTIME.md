# Runtime で Adapter が使える環境変数

Adapter には、Runtime のツール設定（`adapter_runtime`）に書かれた値だけが環境変数として渡される。
値（特にトークン）はこのリポジトリに書かない。

| 環境変数 | 内容 |
|---|---|
| `HOST` / `PORT` | Adapter が待ち受けるアドレス（Tool Gateway が決める） |
| `DEMO_API_BASE_URL` | 社内 API（Sample A のデモ審査システム）の URL |
| `DEMO_API_TOKEN` | 社内 API の Bearer トークン（Runtime の Secret から渡る） |

新しい環境変数が必要なときは、Runtime の設定（Terraform の `adapter_runtime`）を先に変更する。
