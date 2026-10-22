# 📦 Installation Guide - RoomBooking System

This guide will help you set up the RoomBooking system from scratch.

## Prerequisites

Before you begin, ensure you have:

- ✅ **Node.js** version 20 or higher ([Download](https://nodejs.org/))
- ✅ **MySQL** or **MariaDB** version 8.0+ ([Download MySQL](https://dev.mysql.com/downloads/) or [MariaDB](https://mariadb.org/download/))
- ✅ **Git** ([Download](https://git-scm.com/downloads))
- ✅ A text editor (VS Code, Sublime, etc.)

## Step 1: Clone the Repository

```bash
git clone https://github.com/DonyokuKen/NEW-roombooking.git
cd NEW-roombooking
```

## Step 2: Install Dependencies

```bash
npm install
```

This will install all required packages:
- express (web framework)
- ejs (templating engine)
- mysql2 (MySQL driver)
- bcryptjs (password hashing)
- express-session (session management)
- dotenv (environment variables)

## Step 3: Set Up the Database

### 3.1 Create the Database

```bash
# Login to MySQL
mysql -u root -p

# Create database
CREATE DATABASE roombooking;

# Create user and grant permissions
CREATE USER 'roombooking'@'localhost' IDENTIFIED BY 'your_secure_password';
GRANT ALL PRIVILEGES ON roombooking.* TO 'roombooking'@'localhost';
FLUSH PRIVILEGES;

# Exit MySQL
exit;
```

### 3.2 Import the Database Schema

You need the `roombooking.sql` file from the database repository:

```bash
# If you have the SQL file locally:
mysql -u roombooking -p roombooking < /path/to/roombooking.sql

# Or clone the database repository:
git clone https://github.com/DonyokuKen/NEW-roombooking-db.git
mysql -u roombooking -p roombooking < NEW-roombooking-db/roombooking.sql
```

## Step 4: Configure Environment Variables

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your favorite editor
nano .env
# or
vim .env
# or
code .env
```

Update the following values in `.env`:

```env
PORT=3100
NODE_ENV=production

# IMPORTANT: Change this to a random secret string!
SESSION_SECRET=change-this-to-a-long-random-string-for-production

# Database Configuration
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=roombooking
DB_PASS=your_secure_password    # Use the password you set in Step 3.1
DB_NAME=roombooking

# Timezone (adjust to your location)
TZ=Asia/Jakarta
```

### Generate a Secure Session Secret

You can generate a random session secret using:

```bash
# On Linux/Mac:
openssl rand -base64 32

# On Windows (PowerShell):
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# Or use Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Step 5: Verify Database Connection

Test if the application can connect to the database:

```bash
node -e "require('dotenv').config(); require('./lib/db').query('SELECT 1').then(() => console.log('✅ Database connected!')).catch(err => console.error('❌ Database error:', err.message))"
```

You should see: `✅ Database connected!`

## Step 6: Create Missing View Templates

The basic templates are included, but you may need to create additional ones for full functionality:

```bash
# Create view directories
mkdir -p views/rooms views/bookings views/admin/{bookings,rooms,departments,equipment,users}

# Basic templates are already created:
# - views/index.ejs (dashboard)
# - views/auth/login.ejs
# - views/auth/register.ejs
# - views/error.ejs
# - views/layouts/main.ejs

# You'll need to create additional templates for:
# - Room listing and details
# - Booking management
# - Admin panels
# See the server.js routes for required templates
```

## Step 7: Start the Application

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The application will start on `http://localhost:3100` (or the PORT you specified in .env)

## Step 8: Access the Application

Open your browser and navigate to:

```
http://localhost:3100
```

You should see the RoomBooking dashboard!

## Step 9: Create Your First Admin User

You can either:

### Option A: Register through the UI
1. Go to http://localhost:3100/register
2. Create a new account
3. Manually update the database to make yourself admin:

```sql
mysql -u roombooking -p roombooking

UPDATE users SET roles = 'SU' WHERE email = 'your@email.com';
```

### Option B: Use an existing admin account
If your database already has users, log in with an existing admin account (users with roles 'M' or 'SU').

## Troubleshooting

### Problem: "Cannot connect to database"

**Solution:**
1. Check if MySQL is running:
   ```bash
   # Linux
   sudo systemctl status mysql
   # or
   sudo systemctl status mariadb
   
   # Mac
   brew services list | grep mysql
   
   # Windows
   # Check Services app
   ```

2. Verify credentials in `.env`
3. Test connection manually:
   ```bash
   mysql -h 127.0.0.1 -u roombooking -p roombooking
   ```

### Problem: "Port 3100 already in use"

**Solution:**
1. Change the PORT in `.env` to another number (e.g., 3200)
2. Or kill the process using port 3100:
   ```bash
   # Linux/Mac
   lsof -ti:3100 | xargs kill -9
   
   # Windows
   netstat -ano | findstr :3100
   taskkill /PID <PID> /F
   ```

### Problem: "Template not found" errors

**Solution:**
Some view templates may be missing. Check the error message for the specific template file needed and create it based on the examples provided.

### Problem: "bcrypt" installation issues

**Solution:**
If bcryptjs fails to install:
```bash
npm install --force
# or
npm install bcryptjs@latest
```

### Problem: Session issues / "Cannot read session"

**Solution:**
1. Clear browser cookies
2. Restart the server
3. Make sure SESSION_SECRET is set in .env

## Production Deployment

For production deployment:

### 1. Set NODE_ENV
```env
NODE_ENV=production
```

### 2. Use a Process Manager

**Using PM2:**
```bash
npm install -g pm2
pm2 start server.js --name "roombooking"
pm2 startup
pm2 save
```

### 3. Use a Reverse Proxy

Set up Nginx or Apache as a reverse proxy:

**Nginx example:**
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 4. Enable HTTPS

Use Let's Encrypt (certbot):
```bash
sudo certbot --nginx -d yourdomain.com
```

### 5. Regular Backups

Set up automated database backups:
```bash
#!/bin/bash
# backup.sh
DATESTAMP=$(date +%Y%m%d_%H%M%S)
mysqldump -u roombooking -p'your_password' roombooking > backup_${DATESTAMP}.sql
gzip backup_${DATESTAMP}.sql
```

Add to crontab:
```bash
crontab -e
# Add: Daily backup at 2 AM
0 2 * * * /path/to/backup.sh
```

## Next Steps

After installation:

1. ✅ Customize the UI colors in `/public/css/app.css`
2. ✅ Add your organization's logo
3. ✅ Configure email notifications (if needed)
4. ✅ Set up regular database backups
5. ✅ Review and adjust business rules in `server.js`

## Need Help?

If you encounter issues:
1. Check the [README.md](README.md) for general information
2. Review the error logs
3. Open an issue on GitHub with:
   - Error message
   - Steps to reproduce
   - Your environment (OS, Node version, MySQL version)

---

**Happy Booking! 🎉**
