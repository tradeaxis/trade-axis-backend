// backend/src/services/marketStatus.js
// Shared market status — used by tradingController, socketHandler, adminController

let isMarketHoliday = false;
let holidayMessage = '';

const setHoliday = (isHoliday, message = '') => {
  isMarketHoliday = !!isHoliday;
  holidayMessage = message || '';
  console.log(`📅 Market holiday ${isMarketHoliday ? 'ENABLED' : 'DISABLED'}${holidayMessage ? ': ' + holidayMessage : ''}`);
};

const getHolidayStatus = () => ({
  isHoliday: isMarketHoliday,
  message: holidayMessage,
});

const isMarketOpen = () => {
  // Check admin-set holiday
  if (isMarketHoliday) return false;

  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 3600000);

  const day = ist.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;

  const mins = ist.getHours() * 60 + ist.getMinutes();
  // Market hours: 9:15 AM to 3:30 PM IST
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
};

module.exports = { setHoliday, getHolidayStatus, isMarketOpen };