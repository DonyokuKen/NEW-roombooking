#!/bin/bash
# Setup script for RoomBooking system

echo "🏢 Setting up RoomBooking System..."

# Create all necessary view directories
mkdir -p views/layouts
mkdir -p views/auth
mkdir -p views/rooms
mkdir -p views/bookings
mkdir -p views/admin/bookings
mkdir -p views/admin/rooms
mkdir -p views/admin/departments
mkdir -p views/admin/equipment
mkdir -p views/admin/users
mkdir -p views/partials

echo "✅ Directory structure created"

# Install dependencies
if [ -f "package.json" ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo "✅ Dependencies installed"
else
  echo "❌ package.json not found"
  exit 1
fi

# Check for .env file
if [ ! -f ".env" ]; then
  echo "⚠️  .env file not found, copying from .env.example"
  cp .env.example .env
  echo "📝 Please edit .env with your database credentials"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your database credentials"
echo "2. Import the database: mysql -u user -p roombooking < roombooking.sql"
echo "3. Run: npm start"
echo "4. Open: http://localhost:3100"
echo ""
