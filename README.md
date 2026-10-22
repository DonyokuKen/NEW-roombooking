# 🏢 RoomBooking System

> Modern room booking system built with Node.js, Express, and MySQL. Complete rebuild with elegant warm-paper UI design.

![Node.js](https://img.shields.io/badge/node-%3E%3D20-green) ![Express](https://img.shields.io/badge/express-4.19-black) ![MySQL](https://img.shields.io/badge/mysql-8.0-blue)

## ✨ Features

### For Users
- 🔐 **Authentication** - Secure login/registration with bcrypt
- 📅 **Room Browsing** - View all available rooms with details and equipment
- 📝 **Easy Booking** - Simple 3-step booking process with conflict detection
- ✅ **Booking Management** - View, edit, and cancel your bookings
- 👥 **Collaborative Bookings** - Add associated users to bookings
- 📊 **Dashboard** - Overview of stats and today's events

### For Admins
- 🎛️ **Admin Dashboard** - Real-time stats and pending approvals
- ✅ **Booking Approval** - Approve or reject pending bookings
- 🏢 **Room Management** - CRUD operations for rooms
- 🏷️ **Department Management** - Manage departments
- 🛠️ **Equipment Management** - Manage room equipment (kelengkapan)
- 👤 **User Management** - View and manage users

### Business Rules
- ⏰ **48-hour rule** - Non-admin bookings must be made 48 hours in advance
- 🚫 **Conflict detection** - Prevents double bookings
- 🔒 **Role-based access** - User (U), Manager (M), Super Admin (SU)
- ♻️ **Soft deletes** - Data is never permanently deleted
- 📋 **Status tracking** - Pending (P), Approved (A), Rejected (R), Cancelled (C)

## 🗄️ Database Schema

This system uses the existing MySQL database with the following tables:

- **users** - User accounts with roles
- **rooms** - Available rooms
- **departments** - Organization departments
- **kelengkapans** - Equipment/facilities per room
- **trevents** - Bookings (the main booking table)
- **booking_users** - Many-to-many: users associated with bookings
- **mstime** - Time slot master data (hourly slots)
- **push_notification_logs** - Notification tracking

## 🚀 Quick Start

### Prerequisites

- Node.js >= 20
- MySQL/MariaDB 8.0+
- Git

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/DonyokuKen/NEW-roombooking.git
cd NEW-roombooking

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your database credentials

# 4. Import the database
# Make sure your MySQL database 'roombooking' exists
mysql -u your_user -p roombooking < path/to/roombooking.sql

# 5. Start the server
npm start

# For development with auto-reload:
npm run dev
```

The application will be available at `http://localhost:3100`

## ⚙️ Configuration

Edit `.env` file:

```env
PORT=3100
NODE_ENV=production

# Session Secret (CHANGE THIS!)
SESSION_SECRET=your-super-secret-random-string-here

# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=roombooking
DB_PASS=your_database_password
DB_NAME=roombooking

# Timezone
TZ=Asia/Jakarta
```

## 🎨 UI/UX Design

The system features a modern **warm paper design** with:

- **Color Palette**:
  - Background: Warm paper (#F6F1E8)
  - Surfaces: White (#FFFFFF) and light (#FBF7EF)
  - Accents: Amber (#C8853F) and caramel
  - Text: Ink (#1F2421) and muted (#8A8A80)

- **Typography**:
  - Headings: DM Serif Display / Roboto Slab (bold, 600-700)
  - Body: Inter (400-600)

- **Components**:
  - Rounded cards with warm shadows
  - Pill-style badges and buttons
  - Smooth transitions and hover effects
  - Responsive grid layouts

## 📁 Project Structure

```
├── lib/
│   └── db.js              # Database operations
├── public/
│   ├── css/
│   │   └── app.css        # Main stylesheet
│   └── js/
│       └── app.js         # Client-side JavaScript
├── views/
│   ├── layouts/
│   │   └── main.ejs       # Main layout template
│   ├── auth/
│   │   ├── login.ejs
│   │   └── register.ejs
│   ├── rooms/
│   │   ├── index.ejs
│   │   └── show.ejs
│   ├── bookings/
│   │   ├── index.ejs
│   │   ├── show.ejs
│   │   ├── create.ejs
│   │   └── edit.ejs
│   ├── admin/
│   │   ├── dashboard.ejs
│   │   ├── bookings/
│   │   ├── rooms/
│   │   ├── departments/
│   │   ├── equipment/
│   │   └── users/
│   ├── index.ejs          # Home/Dashboard
│   └── error.ejs
├── server.js              # Main application file
├── package.json
├── .env.example
└── README.md
```

## 🔌 API Endpoints

### Public Routes
- `GET /` - Dashboard
- `GET /rooms` - List rooms
- `GET /rooms/:id` - Room details
- `GET /login` - Login page
- `POST /login` - Login action
- `GET /register` - Registration page
- `POST /register` - Register user
- `GET /logout` - Logout

### User Routes (requires authentication)
- `GET /bookings` - My bookings
- `GET /bookings/create` - New booking form
- `POST /bookings` - Create booking
- `GET /bookings/:id` - Booking details
- `GET /bookings/:id/edit` - Edit booking
- `POST /bookings/:id` - Update booking
- `POST /bookings/:id/cancel` - Cancel booking

### Admin Routes (requires admin role)
- `GET /admin` - Admin dashboard
- `GET /admin/bookings` - Manage bookings
- `POST /admin/bookings/:id/approve` - Approve booking
- `POST /admin/bookings/:id/reject` - Reject booking
- `GET /admin/rooms` - Manage rooms
- `GET /admin/departments` - Manage departments
- `GET /admin/equipment` - Manage equipment
- `GET /admin/users` - Manage users

### API Routes
- `GET /api/rooms` - Get all rooms (JSON)
- `GET /api/departments` - Get all departments (JSON)
- `GET /api/kelengkapan?room=:id` - Get equipment by room (JSON)
- `POST /api/check-conflict` - Check booking conflicts (JSON)
- `GET /api/available-times?room=:id&date=:date` - Get available time slots (JSON)

## 👥 User Roles

- **U (User)** - Regular user, can create bookings
- **M (Manager)** - Admin access, can approve/reject bookings
- **SU (Super Admin)** - Full access, can manage users and delete departments

## 🔒 Security Features

- ✅ Password hashing with bcrypt
- ✅ Session-based authentication
- ✅ Role-based access control
- ✅ SQL injection prevention (parameterized queries)
- ✅ XSS protection
- ✅ CSRF protection via session

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Check MySQL is running
systemctl status mysql

# Test connection
mysql -h 127.0.0.1 -u roombooking -p roombooking
```

### Port Already in Use
```bash
# Change PORT in .env file or kill the process
lsof -ti:3100 | xargs kill -9
```

### Session Issues
```bash
# Clear browser cookies or restart the server
```

## 📝 License

MIT License - feel free to use this project for your own purposes.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📧 Contact

For questions or support, please open an issue on GitHub.

---

**Built with ❤️ using Node.js, Express, and MySQL**
