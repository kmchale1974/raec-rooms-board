name: Fetch RAEC Emails

on:
  workflow_dispatch:
  schedule:
    - cron: "10 * * * *" # hourly at :10 (optional—remove if not needed)

permissions:
  contents: read

jobs:
  fetch:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Use Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install deps
        run: npm ci

      # Preflight: ensure creds are present in this job
      - name: Assert IMAP creds present
        shell: bash
        env:
          IMAP_USER: ${{ vars.IMAP_USER || 'raecroominfo.board@gmail.com' }}
          IMAP_PASS: ${{ secrets.IMAP_PASS }}
        run: |
          [[ -n "$IMAP_USER" ]] || { echo "::error::IMAP_USER missing"; exit 1; }
          [[ -n "$IMAP_PASS" ]] || { echo "::error::IMAP_PASS missing (check repo/environment secrets)"; exit 1; }
          echo "IMAP env present."

      - name: Fetch RAEC emails
        run: node scripts/fetch_email.js
        env:
          # If you don't keep IMAP_USER in repo/Env vars, hardcode it here
          IMAP_USER: ${{ vars.IMAP_USER || 'raecroominfo.board@gmail.com' }}
          IMAP_PASS: ${{ secrets.IMAP_PASS }}

      - name: Upload extracted CSVs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: raec-email-csvs
          path: out/attachments/**
          if-no-files-found: warn
