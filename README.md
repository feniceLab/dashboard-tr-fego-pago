# 📊 Dashboard de Tráfego Pago

Dashboard local pra acompanhar campanhas Meta Ads em tempo real — agendamentos, renovações mensais e relatórios de performance pra clientes de gastronomia.

Construído sobre a **Meta Graph API** com Node.js puro (sem framework).

---

## 🎯 O que o dashboard oferece

| Página | URL | Função |
|---|---|---|
| Inicial | `/` | Dashboard cross-client com dados consolidados |
| Agendamentos | `/agendamentos.html` | Posts Facebook agendados via API + cron jobs |
| Renovação | `/renovacao.html` | Fluxo de renovação mensal de campanhas com cards comparativos ANTES x DEPOIS |
| Cliente | `/<cliente>.html` | Dashboard por cliente com filtro de período |
| Reports | `/<cliente>-report.html` | Templates de PDF/PNG vertical pra envio em WhatsApp |

## 🔌 Endpoints API

| Endpoint | Retorno |
|---|---|
| `GET /api/agendamentos` | JSON consolidado: status do token, posts agendados FB de cada cliente, lista de crons |
| `GET /api/renovacao` | JSON com config mensal + métricas ao vivo (gasto histórico + last_month + ROAS) |
| `GET /clientes/<slug>/*` | Serve assets da pasta de cada cliente (logos, imagens) |

Cache de 60s nos endpoints (use `?force=1` pra forçar refresh).

---

## 🚀 Setup local

### Pré-requisitos
- Node.js 18+ (precisa do `fetch` e `FormData` nativos)
- Token Long-Lived Meta Graph API (60 dias)

### Passo a passo

```bash
# 1. Clonar
git clone https://github.com/feniceLab/dashboard-tr-fego-pago.git
cd dashboard-tr-fego-pago

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite .env e cole seu META_GRAPH_TOKEN

# 3. Configurar clientes e renovações (use os .example como template)
cp data/clients-mapping.example.json data/clients-mapping.json
cp data/renovacao-mes.example.json data/renovacao-mes.json
cp data/client-aliases.example.json data/client-aliases.json
cp data/crons.example.json data/crons.json
# Edite os arquivos com IDs reais dos seus clientes

# 4. Iniciar
node server.mjs
```

Abrir [http://localhost:3000](http://localhost:3000).

---

## 🔐 Como gerar o token Meta Graph API

1. Acessar [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Selecionar sua App Meta (canto superior direito)
3. Em "User or Page" → deixar **User Token**
4. Adicionar permissões (todas as 7):
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `pages_manage_metadata`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`
5. Clicar em **"Generate Access Token"** e autorizar
6. Clicar em **"Extend Access Token"** (ícone de relógio) pra estender pra 60 dias
7. Copiar o token e colar em `.env` na variável `META_GRAPH_TOKEN`

---

## 📁 Estrutura

```
dashboard/
├── server.mjs                       # Servidor HTTP + endpoints API
├── package.json
├── .env.example                     # Template de variáveis de ambiente
├── .gitignore
│
├── data/
│   ├── client-aliases.example.json  # Mapa slug → pasta de cliente
│   ├── clients-mapping.example.json # Lista de clientes (page_id, ig_id, agência)
│   ├── crons.example.json           # Cron jobs registrados
│   └── renovacao-mes.example.json   # Config mensal de renovação
│
├── index.html                       # Dashboard principal
├── agendamentos.html                # Agendamentos em tempo real
├── renovacao.html                   # Renovação mensal
│
└── *-report.html                    # Templates de PDF/PNG por cliente
```

---

## 📊 Geração de relatórios PDF/PNG

Os templates `*-report.html` foram desenhados em formato vertical (210×460mm) pra impressão em PDF e captura em PNG, com a página inteira em um único frame.

```powershell
# PDF
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless --disable-gpu --no-sandbox --no-pdf-header-footer `
  --virtual-time-budget=8000 `
  "--print-to-pdf=relatorio.pdf" `
  "http://localhost:3000/cliente-report.html"

# PNG
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless --disable-gpu --no-sandbox --hide-scrollbars `
  --window-size=794,1738 `
  --virtual-time-budget=8000 `
  "--screenshot=relatorio.png" `
  "http://localhost:3000/cliente-report.html"
```

---

## 🛡️ Segurança

### O que NUNCA versionamos
- `.env` — credenciais reais
- `data/clients-mapping.json` — IDs reais de clientes
- `data/renovacao-mes.json` — dados financeiros mensais
- Qualquer arquivo `*token*` — credenciais

Veja `.gitignore` pra lista completa.

### Boas práticas
- Token expira em 60 dias — gerar novo e atualizar `.env` regularmente
- Em produção, usar gerenciador de segredos (AWS Secrets Manager, Doppler, etc) em vez de `.env`
- Repo público: NUNCA commitar dados reais de cliente

---

## 🧠 Processo de Renovação Mensal (SOP integrado)

O dashboard implementa o fluxo de renovação em 5 passos:

1. **Coleta** — Puxar gasto histórico (`maximum`) + gasto mês anterior (`last_month`) via Graph API
2. **Análise** — ROAS histórico e do mês · comparar com benchmark · identificar tendência
3. **Decisão** — Manter / Subir % / Reduzir · definir budget pretendido pro novo mês
4. **Execução** — Ordem importa: AdSet `end_time` → Campaign `lifetime_budget` → Campaign `stop_time`
5. **Verificação** — Confirmar via GET · monitorar pacing diário

### Cálculo do novo lifetime budget

```
NOVO lifetime_budget = GASTO_TOTAL_HISTORICO + BUDGET_PRETENDIDO_NOVO_MES
```

Sem somar o histórico, o novo lifetime fica menor que o já gasto e Meta para a campanha.

### Ordem das operações via API

Meta tem uma validação implícita que rejeita updates fora de ordem (responde `success: true` mas não aplica):

```
PASSO 0 — POST /{campaign-id}    → lifetime_budget = NOVO valor   (se >95% gasto)
PASSO 1 — POST /{adset-id}       → end_time = nova_data
PASSO 2 — POST /{campaign-id}    → stop_time = nova_data
```

---

## 🤝 Como contribuir

1. Fork o repo
2. Crie branch (`git checkout -b feature/nova-funcionalidade`)
3. Commit (`git commit -m "feat: adiciona X"`)
4. Push (`git push origin feature/nova-funcionalidade`)
5. Abra Pull Request

---

## 📜 Licença

MIT — veja [LICENSE](LICENSE).

---

## 🏢 Sobre

Desenvolvido por **Fenice Lab** + **Starken Tecnologia** pra operação interna de tráfego pago em clientes de gastronomia (pizzarias, hamburguerias, academias, etc).

Open source pra que outras agências/equipes possam adaptar pro próprio uso.
