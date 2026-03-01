# EC2 Deployment Guide — Liam Bot System

---

## 1. Launch EC2 Instance

1. Go to **AWS Console → EC2 → Launch Instance**
2. Settings:
   - **Name**: `liam-bot`
   - **AMI**: Ubuntu Server 22.04 LTS (64-bit x86)
   - **Instance type**: `t3.small` (1 vCPU, 2 GB RAM — minimum; use `t3.medium` if running multiple bots)
   - **Key pair**: Create new → name it `liam-bot-key` → download the `.pem` file → save it somewhere safe
   - **Storage**: 20 GB gp3

---

## 2. Security Group Configuration

Create a new security group named `liam-bot-sg`.

### Inbound Rules

| Type       | Protocol | Port | Source          | Reason                         |
|------------|----------|------|-----------------|--------------------------------|
| SSH        | TCP      | 22   | Your IP only    | Admin access (use "My IP")     |

> No other inbound ports are needed. WhatsApp bots connect OUTBOUND only.
> The bot polls WhatsApp servers — nothing connects in.

### Outbound Rules

| Type        | Protocol | Port Range | Destination |
|-------------|----------|------------|-------------|
| All traffic | All      | All        | 0.0.0.0/0   |

---

## 3. Connect to the Instance

```bash
# Fix key permissions (required on Mac/Linux)
chmod 400 ~/path/to/liam-bot-key.pem

# Connect
ssh -i ~/path/to/liam-bot-key.pem ubuntu@<YOUR_EC2_PUBLIC_IP>
```

On **Windows**, use PuTTY or Windows Terminal with the .pem file directly.

---

## 4. Server Setup (run once after first SSH)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version   # should be v20.x
npm --version

# Install PM2 (process manager — keeps bot alive after logout/reboot)
sudo npm install -g pm2

# Install git
sudo apt install -y git

# Install Chromium dependencies (required by whatsapp-web.js/puppeteer)
sudo apt install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libxshmfence1 \
  fonts-liberation libappindicator3-1 libx11-xcb1 \
  xdg-utils wget ca-certificates
```

---

## 5. Clone the Repository

```bash
cd ~
git clone https://github.com/<YOUR_GITHUB_USERNAME>/liam-bot-system.git
cd liam-bot-system
npm install
```

---

## 6. Upload Secret Files

Each bot has its own secrets directory: `secrets/<bot-id>/`

The current structure is:
```
secrets/
  liam_deliveries/
    .env
    service-account.json
```

This path is set via `"secretsDir": "secrets/liam_deliveries"` in `bots.json`.
When you add a new bot, create a new subdirectory for it (e.g. `secrets/new_bot_id/`).

### Option A — SCP (simplest, one-time)

Run these **from your local machine** (not from the server):

```bash
# Create the directory on the server first
ssh -i ~/path/to/liam-bot-key.pem ubuntu@<EC2_IP> \
  "mkdir -p ~/liam-bot-system/secrets/liam_deliveries"

# Upload .env
scp -i ~/path/to/liam-bot-key.pem \
  secrets/liam_deliveries/.env \
  ubuntu@<EC2_IP>:~/liam-bot-system/secrets/liam_deliveries/.env

# Upload service-account.json
scp -i ~/path/to/liam-bot-key.pem \
  secrets/liam_deliveries/service-account.json \
  ubuntu@<EC2_IP>:~/liam-bot-system/secrets/liam_deliveries/service-account.json
```

To upload the entire secrets folder at once (recursive):

```bash
scp -r -i ~/path/to/liam-bot-key.pem \
  secrets/ \
  ubuntu@<EC2_IP>:~/liam-bot-system/secrets/
```

### Option B — Paste content manually (alternative)

```bash
# On the server, create the directory and files
mkdir -p ~/liam-bot-system/secrets/liam_deliveries

nano ~/liam-bot-system/secrets/liam_deliveries/.env
# Paste contents, then Ctrl+O to save, Ctrl+X to exit

nano ~/liam-bot-system/secrets/liam_deliveries/service-account.json
# Paste contents, then Ctrl+O to save, Ctrl+X to exit
```

### Option C — AWS Secrets Manager (production-grade)

Store your .env values as secrets in AWS Secrets Manager, then fetch them at startup
using `aws secretsmanager get-secret-value`. This avoids files on disk entirely.
See: https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets.html

### Adding secrets for a new bot

Each new bot needs its own directory matching the `secretsDir` value in `bots.json`:

```bash
# On your local machine
mkdir -p secrets/new_bot_id

# Create .env and service-account.json inside it, then upload:
ssh -i ~/path/to/liam-bot-key.pem ubuntu@<EC2_IP> \
  "mkdir -p ~/liam-bot-system/secrets/new_bot_id"

scp -i ~/path/to/liam-bot-key.pem \
  secrets/new_bot_id/.env \
  ubuntu@<EC2_IP>:~/liam-bot-system/secrets/new_bot_id/.env

scp -i ~/path/to/liam-bot-key.pem \
  secrets/new_bot_id/service-account.json \
  ubuntu@<EC2_IP>:~/liam-bot-system/secrets/new_bot_id/service-account.json
```

---

## 7. Run the Bot with PM2

```bash
cd ~/liam-bot-system

# Start the bot
pm2 start index.js --name liam-bot

# Save PM2 process list (survives reboots)
pm2 save

# Enable PM2 to start on system boot
pm2 startup
# Run the command it prints (starts with: sudo env PATH=...)

# Check logs
pm2 logs liam-bot

# Check status
pm2 status
```

---

## 8. First Run — WhatsApp QR Code

On first start, `whatsapp-web.js` will print a QR code in the terminal.
Scan it with your WhatsApp phone to link the session.

```bash
# View logs to see the QR code
pm2 logs liam-bot --lines 50
```

The session is saved locally after scanning, so you won't need to scan again unless
the session is invalidated (phone disconnected, logout, etc.).

---

## 9. Useful PM2 Commands

```bash
pm2 restart liam-bot     # Restart the bot
pm2 stop liam-bot        # Stop the bot
pm2 delete liam-bot      # Remove from PM2
pm2 logs liam-bot        # Stream live logs
pm2 logs liam-bot --lines 200   # See last 200 lines
pm2 monit                # Interactive dashboard
```

---

## 10. CI/CD — Automatic Deploy on GitHub Push

This uses **GitHub Actions** to SSH into your EC2, pull the latest code, and restart PM2.

### Step 1 — Add GitHub Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these secrets:

| Name              | Value                                             |
|-------------------|---------------------------------------------------|
| `EC2_HOST`        | Your EC2 public IP or DNS                         |
| `EC2_USER`        | `ubuntu`                                          |
| `EC2_SSH_KEY`     | Contents of your `.pem` file (the full private key) |

To get the key content: `cat ~/path/to/liam-bot-key.pem`

### Step 2 — Create the GitHub Actions Workflow

Create this file in your repo: `.github/workflows/deploy.yml`

```yaml
name: Deploy to EC2

on:
  push:
    branches:
      - main   # triggers on every push to main

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd ~/liam-bot-system
            git pull origin main
            npm install --production
            pm2 restart liam-bot
```

### How it works

1. You push code changes to `main` on GitHub
2. GitHub Actions automatically SSHes into EC2
3. Pulls the latest code with `git pull`
4. Runs `npm install` to pick up any new dependencies
5. Restarts the bot with PM2

> Secret files (`secrets/<bot-id>/.env` and `secrets/<bot-id>/service-account.json`)
> are already on the server and NOT touched by this pipeline.
> They only need to be uploaded once per bot (Step 6 above).
> When adding a new bot, manually upload its secrets directory before deploying.

### Adding a New Bot

To add a new bot type:
1. Add entry to `bots.json`
2. Create `tools/<newbot>.js` and `logic/<newbot>.js`
3. Register in `logicFactory.js`
4. Push to `main` — CI/CD handles the rest

---

## 11. Stopping and Starting the Instance

You can freely stop and start the EC2 instance without losing any data.

### What survives a stop/start

| Data | Where it lives | Safe? |
|------|---------------|-------|
| Orders | Google Sheets | Yes — external |
| Calendar events | Google Calendar | Yes — external |
| Code, `.env`, secrets | EBS root volume | Yes — persists on stop |
| WhatsApp session | `.wwebjs_auth/` on EBS | Yes — persists on stop |
| In-memory chat sessions | RAM | No — lost on stop (users mid-order must restart) |

> **Stop vs Terminate**: Stop preserves the EBS volume. Terminate deletes it permanently. Never terminate unless you want to remove the instance entirely.

### Stop the instance (AWS Console or CLI)

```bash
# AWS CLI (from your local machine)
aws ec2 stop-instances --instance-ids <YOUR_INSTANCE_ID>
```

Or: AWS Console → EC2 → Instances → select instance → **Instance State → Stop**

### Start the instance

```bash
# AWS CLI
aws ec2 start-instances --instance-ids <YOUR_INSTANCE_ID>
```

Or: AWS Console → EC2 → Instances → select instance → **Instance State → Start**

### Bot auto-starts on boot

As long as you ran `pm2 startup` and `pm2 save` during setup (Step 7), the bot starts automatically when the instance boots — no manual action needed.

To verify auto-start is configured:

```bash
# Should show liam-bot with status "online" after instance starts
pm2 status
```

If the bot didn't start automatically, run:

```bash
cd ~/liam-bot-system
pm2 start index.js --name liam-bot
pm2 save
```

---

## 12. Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot crashes on start | `pm2 logs liam-bot` — check for missing env vars or missing files |
| QR code not appearing | `pm2 logs liam-bot --lines 100` — look for the QR output |
| WhatsApp session expired | Delete `.wwebjs_auth/` folder, restart bot, rescan QR |
| Puppeteer crashes | Re-run the `apt install` command in Step 4 for missing Chromium libs |
| Port 22 blocked | Check security group inbound rules — your IP may have changed |
| `git pull` fails in CI/CD | Check that `EC2_SSH_KEY` secret contains the full `.pem` content |

### Check if process is running

```bash
pm2 status
ps aux | grep node
```

### View system resource usage

```bash
htop   # install with: sudo apt install htop
```

---

## File Checklist Before First Start

- [ ] `secrets/liam_deliveries/.env` uploaded to server
- [ ] `secrets/liam_deliveries/service-account.json` uploaded to server
- [ ] `npm install` completed successfully
- [ ] PM2 is installed (`pm2 --version`)
- [ ] PM2 startup hook is configured (`pm2 startup` + `pm2 save`)
