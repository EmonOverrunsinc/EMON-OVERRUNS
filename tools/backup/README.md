# Backup to your PC (extra hard drive)

Copies the whole E-Portal database (every table) and every uploaded file (photos, scans, signatures) into a new
folder for each day, for example `D:\EMON-BACKUP\2026-10-17\`. Supabase Pro also keeps its own daily backups; this is
your extra copy at the office.

## One time
1. Copy this folder (`tools\backup`) to the PC, for example to `C:\EMON-BACKUP-TOOL`. Node.js is already installed.
2. Copy `settings.example.txt` to `settings.txt` and fill it in (open it with Notepad):
   - `BACKUP_FOLDER`: the extra hard drive, for example `D:\EMON-BACKUP`.
   - `DATABASE_URL`: Supabase › **Project Settings › Database › Connection string › URI** (Session pooler). Put your
     database password in it.
   - `SERVICE_ROLE_KEY`: Supabase › **Project Settings › API › service_role** (secret). Needed for the files.
   Keep `settings.txt` private; never send it to anybody.
3. Double-click **run-backup.bat**. The first time it installs what it needs, then it shows `BACKUP DONE`.

## Every day by itself
Windows › **Task Scheduler › Create Basic Task** › name `EMON Backup` › **Daily**, 9:00 PM › **Start a program** ›
Program: `C:\EMON-BACKUP-TOOL\run-backup.bat`, Add arguments: `auto` › Finish. Backups older than `KEEP_DAYS`
(60 days) are removed by themselves.

Each day's folder has `database.sql` (all rows, can be loaded again), `tables\*.json` (one file per table, easy to
read), `files\` (all uploads) and `backup-log.txt`.
