# GCP Compute Engine Deployment Guide — Liam Bot System

> **Complete beginner guide.** No prior GCP experience required.
> Estimated setup time: ~30–45 minutes on first deployment.

---

## Prerequisites

- A Google account (Gmail works)
- A credit card (GCP requires one even for free-tier usage; you won't be charged during the free trial)
- Your project code pushed to a GitHub repository

---

## 1. Create a GCP Account and Project

### 1.1 — Sign up / Sign in

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your Google account
3. If prompted, accept the Terms of Service and start a free trial (you get $300 in credits for 90 days)

### 1.2 — Create a new Project

1. At the top of the page, click the project dropdown (it says **"Select a project"** or shows your current project name)
2. Click **"New Project"** (top right of the popup)
3. Settings:
   - **Project name**: `liam-bot` (or any name you like)
   - Leave **Organization** as-is
4. Click **Create**
5. Wait a few seconds, then select your new project from the dropdown

---

## 2. Enable Required APIs

GCP services must be explicitly enabled before use.

1. In the left sidebar, go to **APIs & Services → Enable APIs and Services**
   (or search "API" in the top search bar)
2. Search for and enable each of these:
   - **Compute Engine API** — click it → click **Enable**

> [!IMPORTANT]
> **Vertex AI API** is already authorized via your `service-account.json`. However, for advanced features like **Context Caching** (which the bot uses to save money), you must ensure your Service Account has the **Vertex AI Administrator** role (see Step 10).

---

## 3. Create a VM Instance

1. In the left sidebar, go to **Compute Engine → VM Instances**
2. If prompted, wait for Compute Engine to initialize (takes ~1 minute the first time)
3. Click **Create Instance**

### Instance Configuration

| Setting | Value |
|---------|-------|
| **Name** | `liam-bot` (Note: You **cannot change this name** after creation. If you already created it with a different name, just use that name everywhere in the guide). |
| **Region** | `us-central1 (Iowa)` — (Must be `us-central1`, `us-west1`, or `us-east1` for Free Tier) |
| **Zone** | `us-central1-a` |
| **Machine configuration** | Series: `E2`, Machine type: `e2-micro` (2 vCPU, 1 GB RAM — **FREE TIER ELIGIBLE**) |
| **Boot disk** | Click **Change** → OS: `Ubuntu`, Version: `Ubuntu 22.04 LTS`, Size: `30 GB` (max free), Disk type: **Standard persistent disk** (REQUIRED for Free Tier) |
| **Firewall** | Leave both **Allow HTTP/HTTPS** unchecked (bot uses outbound only) |

4. Scroll down and click **Create**
5. Wait ~1 minute for the instance to start — you'll see a green checkmark next to it

---

## 4. Reserve a Static IP Address

By default, your VM gets a new external IP every time it restarts. A static IP stays the same forever.

1. In the left sidebar, go to **VPC Network → IP Addresses**
2. Find the external IP currently assigned to your `liam-bot` instance (it shows "Ephemeral")
3. Click the three-dot menu on the right → **"Promote to static IP address"**
4. Give it a name: `liam-bot-ip`
5. Click **Reserve**

Your IP is now permanent. Write it down — you'll need it throughout this guide:

```
YOUR_VM_IP = ___________________
```

---

## 5. Connect to Your VM

### Option A — Browser SSH (simplest, no setup needed)

1. Go to **Compute Engine → VM Instances**
2. Click the **SSH** button next to your `liam-bot` instance
3. A terminal window opens in your browser — you're connected!

> Use this for all one-time setup steps below.

### Option B — gcloud CLI (Recommended for Local Access)

The `gcloud` CLI (Command Line Interface) is the official tool from Google to manage your project and VM from your local Windows machine. 

#### Installation (Windows):
1.  **Download:** Download the [Google Cloud CLI Installer for Windows](https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe).
2.  **Run:** Open the `.exe` and follow the setup wizard. Leave the default settings (it will install to `~\AppData\Local\Google\Cloud SDK`).
3.  **Finish:** At the end, check **"Run 'gcloud init'"** and click **Finish**.
4.  **Authorize:** A browser window will open. Sign in with your Google account and click **Allow**.
5.  **Initialize:** In the terminal that opens, follow the prompts:
    - Choose `[1] Re-initialize this configuration` (if asked).
    - Choose your project (e.g., `liam-bot`).
    - Choose a default zone (e.g., `us-central1-a`).

#### Connect via Local Terminal:
Once successfully initialized, you can connect from your standard Windows PowerShell anytime:
```powershell
gcloud compute ssh liam-bot --zone=us-central1-a
```

---

## 6. Server Setup (run once after first SSH)

Run all of this inside your VM terminal:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version   # should show v20.x
npm --version

# Install PM2 (keeps the bot running after you disconnect / on reboot)
sudo npm install -g pm2

# Install Git
sudo apt install -y git

# Install Chromium system dependencies (required by whatsapp-web.js / Puppeteer)
sudo apt install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libxshmfence1 \
  fonts-liberation libappindicator3-1 libx11-xcb1 \
  xdg-utils wget ca-certificates

# OPTIONAL: Setup Swap File (CRITICAL if using e2-micro / Free Tier)
# This uses your disk as extra RAM to prevent crashes during busy times.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 7. Set Up SSH Keys (needed for CI/CD and gcloud SCP uploads)

Run this inside the VM terminal:

```bash
# Generate an SSH key pair for GitHub Actions to use
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github-actions-key -N ""

# Add the public key to the VM's authorized_keys so external tools can connect
cat ~/.ssh/github-actions-key.pub >> ~/.ssh/authorized_keys

# Print the private key — copy ALL of this output (including BEGIN/END lines)
cat ~/.ssh/github-actions-key
```

Save the private key output — you'll paste it into GitHub Secrets in Step 14.

---

## 8. Clone the Repository

Run inside the VM terminal:

```bash
cd ~
git clone https://github.com/<YOUR_GITHUB_USERNAME>/liam-bot-system.git
cd liam-bot-system
npm install
```

Replace `<YOUR_GITHUB_USERNAME>` with your actual GitHub username.

---

## 9. Upload Secret Files

Your `.env` and `service-account.json` files must be on the VM but are **never committed to Git**.

The expected structure on the server is:
```
~/liam-bot-system/
  secrets/
    liam_deliveries/
      .env
      service-account.json
```

### Option A — Upload via gcloud CLI (from your local machine)

Run these commands **on your local machine** (not inside the VM):

```bash
# Create the secrets directory on the VM
gcloud compute ssh liam-bot --zone=us-central1-a \
  --command="mkdir -p ~/liam-bot-system/secrets/liam_deliveries"

# Upload .env
gcloud compute scp \
  secrets/liam_deliveries/.env \
  liam-bot:~/liam-bot-system/secrets/liam_deliveries/.env \
  --zone=us-central1-a

# Upload service-account.json
gcloud compute scp \
  secrets/liam_deliveries/service-account.json \
  liam-bot:~/liam-bot-system/secrets/liam_deliveries/service-account.json \
  --zone=us-central1-a
```

To upload the entire secrets folder at once:

```bash
gcloud compute scp --recurse \
  secrets/ \
  liam-bot:~/liam-bot-system/secrets/ \
  --zone=us-central1-a
```

### Option B — Paste content manually (if gcloud CLI is not installed locally)

In your VM browser terminal:

```bash
# Create the directory
mkdir -p ~/liam-bot-system/secrets/liam_deliveries

# Create the .env file (nano will open a text editor)
nano ~/liam-bot-system/secrets/liam_deliveries/.env
# Paste your .env contents, then press Ctrl+O to save, Ctrl+X to exit

# Create service-account.json
nano ~/liam-bot-system/secrets/liam_deliveries/service-account.json
# Paste your service-account.json contents, then Ctrl+O, Ctrl+X
```

---

## 10. (CRITICAL) Fix Permissions for Context Caching

Since the bot uses **Vertex AI Context Caching** to reduce costs, the Service Account needs higher permissions than the default "User" role.

1. Go to **IAM & Admin → IAM**.
2. Find your Service Account in the list.
3. Click the **Edit (pencil icon)**.
4. Click **Add Another Role**.
5. Select **Vertex AI → Vertex AI Administrator**.
   *Note: "Vertex AI User" is NOT enough for creating cached contents.*
6. Click **Save**.

## 11. Run the Bot with PM2

Inside the VM terminal:

```bash
cd ~/liam-bot-system

# Start the bot
pm2 start index.js --name liam-bot

# Save PM2 process list (so it survives reboots)
pm2 save

# Configure PM2 to auto-start on system boot
pm2 startup
# Run the command that it prints (it starts with: sudo env PATH=...)
```

---

## 11. First Run — Scan the WhatsApp QR Code

On first start, the bot prints a QR code that you must scan with your WhatsApp phone.

```bash
# View live logs and find the QR code
pm2 logs liam-bot --lines 50
```

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code shown in the terminal
4. You'll see `[Bot Name] ONLINE` in the logs once connected

The session is saved to disk — you won't need to scan again unless the phone disconnects or you delete `.wwebjs_auth/`.

---

## 12. Useful PM2 Commands

```bash
pm2 status                        # Show bot status (online/stopped)
pm2 logs liam-bot                 # Stream live logs
pm2 logs liam-bot --lines 200     # Show last 200 log lines
pm2 restart liam-bot              # Restart the bot
pm2 stop liam-bot                 # Stop the bot
pm2 delete liam-bot               # Remove from PM2
pm2 monit                         # Live dashboard (CPU, memory, logs)
```

---

## 13. CI/CD — Automatic Deploy on GitHub Push

This uses **GitHub Actions** to SSH into your VM, pull new code, and restart PM2 whenever you push to `main`.

### Step 1 — Add GitHub Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these three secrets:

| Secret name       | Value                                                                  |
|-------------------|------------------------------------------------------------------------|
| `GCP_VM_HOST`     | Your static IP from Step 4 (e.g. `34.123.45.67`)                      |
| `GCP_VM_USER`     | `ubuntu` — the default Linux user on Ubuntu VMs                        |
| `GCP_VM_SSH_KEY`  | The full private key you copied in Step 7 (including BEGIN/END lines)  |

### Step 2 — Create the GitHub Actions Workflow

Create the file `.github/workflows/deploy.yml` in your repository:

```yaml
name: Deploy to GCP Compute Engine

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.GCP_VM_HOST }}
          username: ${{ secrets.GCP_VM_USER }}
          key: ${{ secrets.GCP_VM_SSH_KEY }}
          script: |
            cd ~/liam-bot-system
            git pull origin main
            npm install --production
            pm2 restart liam-bot
```

### How it works

1. You push code changes to `main` on GitHub
2. GitHub Actions SSHes into your GCP VM automatically
3. Pulls the latest code with `git pull`
4. Runs `npm install` to pick up any new dependencies
5. Restarts the bot with PM2

> Secret files (`secrets/<bot-id>/.env` and `secrets/<bot-id>/service-account.json`)
> live only on the server and are **never touched by this pipeline**.
> They only need to be uploaded once (Step 9). When adding a new bot, upload its
> secrets directory manually before deploying.

---

## 14. Stopping and Starting the Instance

You can freely stop and start the VM without losing any data.

### What survives a stop/start

| Data | Where it lives | Safe on stop? |
|------|----------------|---------------|
| Orders | Google Sheets | Yes — external |
| Calendar events | Google Calendar | Yes — external |
| Code, `.env`, secrets | Persistent disk | Yes — persists |
| WhatsApp session | `.wwebjs_auth/` on disk | Yes — persists |
| In-memory chat sessions | RAM | No — users mid-order must restart |

### Stop the instance (save money when not needed)

**Cloud Console:**
Compute Engine → VM Instances → select `liam-bot` → **Stop**

**gcloud CLI:**
```bash
gcloud compute instances stop liam-bot --zone=us-central1-a
```

### Start the instance

**Cloud Console:**
Compute Engine → VM Instances → select `liam-bot` → **Start/Resume**

**gcloud CLI:**
```bash
gcloud compute instances start liam-bot --zone=us-central1-a
```

> PM2 auto-starts the bot when the VM boots (as long as you ran `pm2 startup` + `pm2 save` in Step 10).

---

## 15. Estimated Cost

| Resource | Spec | Approx. monthly cost |
|----------|------|----------------------|
| e2-micro VM (Free Tier Regions) | 2 vCPU, 1 GB | **$0.00** |
| 30 GB Standard Persistent Disk | — | **$0.00** |
| Static IP (while attached to running VM) | — | Free |
| Static IP (while VM is stopped) | — | ~$7.20 USD/month |
| **Total (running 24/7)** | | **$0.00** |

> Your $300 free trial credit covers this for months. After the trial, billing begins.
> Stop the VM when not needed to save money.

---

## 16. Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot crashes on start | `pm2 logs liam-bot` — check for missing env vars or missing secret files |
| QR code not appearing | `pm2 logs liam-bot --lines 100` — look for the QR output |
| WhatsApp session expired | Delete `~/.wwebjs_auth/` folder, restart bot, rescan QR |
| Puppeteer / Chrome crashes | Re-run the `apt install` block in Step 6 |
| SSH connection refused | Check that you added the public key to `authorized_keys` (Step 7) |
| `git pull` fails in CI/CD | Check that `GCP_VM_SSH_KEY` in GitHub Secrets contains the full private key |
| VM IP changed | You skipped Step 4 — reserve a static IP to prevent this |

### Useful diagnostic commands

```bash
# Check bot status
pm2 status

# Check resource usage
htop   # install with: sudo apt install htop

# Check if node process is running
ps aux | grep node

# Check disk space
df -h

# Check available memory
free -h
```

---

## File Checklist Before First Start

- [ ] GCP project created and Compute Engine API enabled
- [ ] VM instance created (`e2-small`, Ubuntu 22.04, 20 GB disk)
- [ ] Static IP reserved and noted
- [ ] Node.js 20.x installed (`node --version`)
- [ ] PM2 installed (`pm2 --version`)
- [ ] Chromium dependencies installed (Step 6 apt block)
- [ ] SSH key pair generated and public key added to `authorized_keys` (Step 7)
- [ ] Repository cloned and `npm install` completed
- [ ] `secrets/liam_deliveries/.env` uploaded to server
- [ ] `secrets/liam_deliveries/service-account.json` uploaded to server
- [ ] Bot started with PM2 (`pm2 start index.js --name liam-bot`)
- [ ] PM2 startup hook configured (`pm2 startup` + `pm2 save`)
- [ ] WhatsApp QR code scanned and bot shows `ONLINE`
- [ ] GitHub Secrets added (`GCP_VM_HOST`, `GCP_VM_USER`, `GCP_VM_SSH_KEY`)
- [ ] `.github/workflows/deploy.yml` created and pushed to repo
