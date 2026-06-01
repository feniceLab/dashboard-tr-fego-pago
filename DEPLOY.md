# 🚀 Deploy — Dashboard de Tráfego Pago

Guia completo pra subir o dashboard em outro ambiente (Mac local + VPS produção).

---

## 📋 Pré-requisitos

| Item | Mac local | VPS produção |
|---|---|---|
| Node.js | ≥ 18 (precisa fetch + FormData nativos) | ≥ 18 |
| Git | Sim | Sim |
| Chrome (PDF/PNG) | Sim | Opcional (só se gerar reports na VPS) |
| Token Meta | Sim | Sim |
| PAT GitHub | Só pra push | Não (deploy só clona) |

---

## 🖥️ Parte 1 — Setup no Mac

### 1. Clonar o repositório

```bash
# Escolha onde quer o repo (recomendado: fora da sincronização do iCloud/Drive)
cd ~/Code   # ou crie a pasta: mkdir -p ~/Code && cd ~/Code

git clone https://github.com/feniceLab/dashboard-tr-fego-pago.git
cd dashboard-tr-fego-pago
```

### 2. Configurar credenciais (se for fazer push)

```bash
# Configurar identidade local
git config user.name "Seu Nome"
git config user.email "seu@email.com"

# Pra push: usar GitHub CLI (recomendado) OU PAT inline
# Opção A — GitHub CLI (mais limpo)
brew install gh
gh auth login  # selecionar HTTPS + login via browser

# Opção B — PAT inline (quando precisar push, manualmente)
PAT="github_pat_..."  # ver Clientes/Tokens/GitHub PAT.md
git remote set-url origin "https://x-access-token:${PAT}@github.com/feniceLab/dashboard-tr-fego-pago.git"
git push
git remote set-url origin "https://github.com/feniceLab/dashboard-tr-fego-pago.git"  # limpar URL depois
```

### 3. Variáveis de ambiente

```bash
# Copiar template
cp .env.example .env

# Editar com seu editor preferido
nano .env  # ou: vim .env / code .env
```

Conteúdo mínimo do `.env`:

```env
PORT=3000
META_GRAPH_TOKEN=EAA...   # ver Clientes/Tokens/Graph API Token.md
```

### 4. Configurar clientes (dados reais)

```bash
# Copiar templates
cp data/clients-mapping.example.json data/clients-mapping.json
cp data/renovacao-mes.example.json data/renovacao-mes.json
cp data/client-aliases.example.json data/client-aliases.json
cp data/crons.example.json data/crons.json

# Editar cada um com os IDs reais dos seus clientes
nano data/clients-mapping.json
```

> ⚠️ Esses 4 arquivos `.json` (sem `.example`) estão no `.gitignore` — nunca vão pro Git.

### 5. Rodar localmente

```bash
node server.mjs
```

Abrir [http://localhost:3000](http://localhost:3000).

### 6. (Opcional) Migrar dados do PC Windows pro Mac

Os dados sensíveis ficam no Google Drive compartilhado. No Mac, instale o Google Drive Desktop e sincronize a pasta. Os caminhos mudam:

| Windows | Mac |
|---|---|
| `g:\Drives compartilhados\...` | `~/Library/CloudStorage/GoogleDrive-EMAIL/Drives compartilhados/...` |

No Mac, atualize o `.env` com o caminho correto se for usar fallback de arquivo:

```env
TOKEN_FILE=/Users/SEU_USUARIO/Library/CloudStorage/GoogleDrive-EMAIL/Drives compartilhados/Fenice Lab/Fenice Lab/Fenice Lab/Clientes/Tokens/Graph API Token.md
CLIENTS_DIR=/Users/SEU_USUARIO/Library/CloudStorage/GoogleDrive-EMAIL/Drives compartilhados/Fenice Lab/Fenice Lab/Fenice Lab/Clientes
```

---

## ☁️ Parte 2 — Deploy na VPS (Ubuntu/Debian)

### Cenário recomendado

- **VPS**: Hetzner CX11 (€4/mês) ou DigitalOcean Droplet ($6/mês) — 1 GB RAM é suficiente
- **OS**: Ubuntu 24.04 LTS
- **Domínio**: subdomínio próprio (ex: `relatorios.fenicelab.com.br`)
- **SSL**: Caddy automático (Let's Encrypt)
- **Process manager**: PM2 (mantém node rodando 24/7)

### 1. Conectar na VPS

```bash
ssh root@SEU_IP_DA_VPS
# OU se tiver user não-root:
ssh USUARIO@SEU_IP_DA_VPS
```

### 2. Setup inicial do servidor (executar uma vez)

```bash
# Atualizar pacotes
apt update && apt upgrade -y

# Instalar Node.js 22 (LTS atual)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Confirmar
node --version  # deve mostrar v22.x
npm --version

# Instalar git, caddy (proxy + SSL), pm2 (process manager)
apt install -y git
apt install -y caddy
npm install -g pm2

# (Opcional) Criar usuário dedicado pra rodar o app
adduser --disabled-password --gecos "" dashboard
usermod -aG sudo dashboard
```

### 3. Clonar o repositório

```bash
# Como user dashboard (se criou) ou root:
su - dashboard   # se criou usuário
# ou continue como root

cd ~
git clone https://github.com/feniceLab/dashboard-tr-fego-pago.git
cd dashboard-tr-fego-pago
```

### 4. Configurar variáveis e dados

```bash
# Configurar .env
cp .env.example .env
nano .env
```

Conteúdo do `.env` na VPS:

```env
PORT=3000
META_GRAPH_TOKEN=EAA...   # Copie do seu PC local
```

```bash
# Configurar dados dos clientes
cp data/clients-mapping.example.json data/clients-mapping.json
cp data/renovacao-mes.example.json data/renovacao-mes.json
cp data/client-aliases.example.json data/client-aliases.json
cp data/crons.example.json data/crons.json

# Editar cada um com IDs reais
nano data/clients-mapping.json
nano data/renovacao-mes.json
nano data/client-aliases.json
nano data/crons.json
```

### 5. Subir logos (assets)

Os logos já vão no git via `assets/logos/*.png`. Não precisa configurar mais nada — já estarão disponíveis após `git clone`.

### 6. Testar manualmente

```bash
node server.mjs
# Em outro terminal: curl http://localhost:3000/api/agendamentos | head
# Ctrl+C pra parar
```

### 7. Configurar PM2 (process manager)

```bash
# Iniciar com PM2
pm2 start server.mjs --name dashboard-trafego --env production
pm2 save                  # salva configuração
pm2 startup               # gera comando pra rodar no boot
# Cole o comando que ele imprime e execute como root

# Útil:
pm2 status                # ver status
pm2 logs dashboard-trafego # ver logs
pm2 restart dashboard-trafego  # reiniciar
pm2 stop dashboard-trafego # parar
```

### 8. Configurar domínio + SSL com Caddy

Apontar DNS do subdomínio (ex: `relatorios.fenicelab.com.br`) pro IP da VPS — registro `A` na Cloudflare/Registro.br/etc.

Editar Caddyfile:

```bash
sudo nano /etc/caddy/Caddyfile
```

Conteúdo:

```caddyfile
relatorios.fenicelab.com.br {
    reverse_proxy localhost:3000

    # Opcional: log estruturado
    log {
        output file /var/log/caddy/dashboard.log
        format json
    }

    # Opcional: headers de segurança
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```

Recarregar Caddy:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy   # deve estar active (running)
```

Caddy automaticamente:
- Gera certificado SSL via Let's Encrypt
- Renova automaticamente a cada 60 dias
- Força HTTPS

Pronto. Acessar [https://relatorios.fenicelab.com.br](https://relatorios.fenicelab.com.br).

### 9. Firewall (opcional mas recomendado)

```bash
# Permitir apenas SSH, HTTP, HTTPS
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 10. Atualizações futuras

Quando fizer push de mudanças no GitHub, na VPS:

```bash
cd ~/dashboard-tr-fego-pago
git pull origin main
pm2 restart dashboard-trafego
```

Ou crie um script `deploy.sh`:

```bash
cat > deploy.sh <<'EOF'
#!/bin/bash
set -e
cd ~/dashboard-tr-fego-pago
git pull origin main
pm2 restart dashboard-trafego
echo "Deploy concluído!"
EOF
chmod +x deploy.sh
```

Aí basta: `./deploy.sh`

---

## 🤖 Continuar trabalho em outro Claude (no Mac)

Quando abrir o Claude Code no Mac, dê este contexto inicial:

```
Estou continuando um projeto. Repositório: https://github.com/feniceLab/dashboard-tr-fego-pago

Tokens estão em arquivos separados (não versionados no Git):
- Token Meta Graph API: Clientes/Tokens/Graph API Token.md (no Google Drive compartilhado)
- GitHub PAT: Clientes/Tokens/GitHub PAT.md (no Google Drive compartilhado)

Documentação completa em:
- Infraestrutura/Dashboard de Trafego Pago/ (5 arquivos no Obsidian)
- Memória: reference_dashboard_trafego_pago

Por favor leia esses docs antes de prosseguir.
```

O Claude no Mac vai:
1. Ler o memory (carregado automaticamente)
2. Ler os docs do Obsidian (se Google Drive estiver montado)
3. Saber o estado atual do projeto

---

## 🔐 Segurança em produção

### O que JAMAIS commitar no Git
- `.env`
- `data/*.json` (versões reais)
- `*token*.md`
- Logs

### Como atualizar token Meta na VPS

```bash
ssh dashboard@SEU_VPS
cd ~/dashboard-tr-fego-pago
nano .env
# Cole o novo META_GRAPH_TOKEN
pm2 restart dashboard-trafego
```

### Como revogar acesso emergencial

Se token Meta vazar:
1. Acessar [developers.facebook.com](https://developers.facebook.com) → sua App → App Roles → Tokens → Revoke
2. Gerar novo token
3. Atualizar `.env` na VPS

Se PAT GitHub vazar:
1. Acessar [github.com/settings/tokens](https://github.com/settings/tokens) → Delete
2. Gerar novo PAT
3. Atualizar `Clientes/Tokens/GitHub PAT.md` no Drive

---

## 📊 Monitoramento básico

Adicionar uptime checker gratuito:
- [UptimeRobot](https://uptimerobot.com) — checa a cada 5 min, alerta por e-mail
- Monitorar URL: `https://relatorios.fenicelab.com.br/api/agendamentos`
- Se cair, recebe alerta

PM2 também tem keep-alive built-in:

```bash
pm2 install pm2-logrotate    # rotaciona logs
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
```

---

## 🆘 Troubleshooting

### Site não abre

```bash
# Verificar se Node está rodando
pm2 status

# Ver logs
pm2 logs dashboard-trafego --lines 50

# Verificar Caddy
sudo systemctl status caddy
sudo journalctl -u caddy -n 50

# Verificar porta 3000 local
curl http://localhost:3000

# Verificar DNS apontando
dig relatorios.fenicelab.com.br
```

### Token expirou (60 dias)

```bash
# Gerar novo no Graph API Explorer (60 dias)
ssh dashboard@VPS
cd ~/dashboard-tr-fego-pago
nano .env  # atualizar META_GRAPH_TOKEN
pm2 restart dashboard-trafego
```

### Repositório atrasado

```bash
ssh dashboard@VPS
cd ~/dashboard-tr-fego-pago
git pull origin main
pm2 restart dashboard-trafego
```

---

## 💰 Custos estimados mensais

| Item | Custo (BRL) |
|---|---|
| VPS Hetzner CX11 (1 vCPU, 2GB RAM, 20GB SSD) | ~R$ 25/mês |
| Domínio `.com.br` (Registro.br anual) | ~R$ 8/mês |
| Cloudflare (DNS gratuito) | R$ 0 |
| UptimeRobot (50 monitores grátis) | R$ 0 |
| **Total** | **~R$ 33/mês** |

Alternativa mais barata: Render free tier ou Railway free tier, mas têm cold start.

---

*Última atualização: 2026-06-01*
