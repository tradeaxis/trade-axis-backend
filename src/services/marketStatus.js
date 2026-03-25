// backend/src/services/marketStatus.js
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

// Commodity keywords used to identify MCX/commodity symbols
const COMMODITY_KEYWORDS = /^(GOLD|GOLDM|GOLDGUINEA|GOLDPETAL|SILVER|SILVERM|SILVERMIC|CRUDE|CRUDEOIL|NATURALGAS|COPPER|ZINC|ALUMINIUM|LEAD|NICKEL|COTTON|MENTHAOIL)/i;

/**
 * Check if a symbol belongs to the commodity/MCX segment
 */
const isCommoditySymbol = (symbol) => {
  if (!symbol) return false;
  return COMMODITY_KEYWORDS.test(String(symbol).toUpperCase());
};

/**
 * Check if market is open.
 * @param {string|null} symbol — if provided, uses commodity hours for MCX symbols
 */
const isMarketOpen = (symbol = null) => {
  if (isMarketHoliday) return false;

  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 3600000);

  const day = ist.getDay();
  if (day === 0 || day === 6) return false;

  const mins = ist.getHours() * 60 + ist.getMinutes();

  // Commodity (MCX) market: 9:00 AM to 11:30 PM IST
  if (symbol && isCommoditySymbol(symbol)) {
    return mins >= 9 * 60 && mins <= 23 * 60 + 30;
  }

  // Default: Equity/Index market 9:15 AM to 3:30 PM IST
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
};

/**
 * Check if ANY market segment is currently open (used by P&L loop)
 * Returns true if either equity (9:15-15:30) or commodity (9:00-23:30) is open
 */
const isAnyMarketOpen = () => {
  if (isMarketHoliday) return false;

  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 3600000);

  const day = ist.getDay();
  if (day === 0 || day === 6) return false;

  const mins = ist.getHours() * 60 + ist.getMinutes();
  // Widest window: 9:00 AM to 11:30 PM (covers both equity + commodity)
  return mins >= 9 * 60 && mins <= 23 * 60 + 30;
};

module.exports = { setHoliday, getHolidayStatus, isMarketOpen, isCommoditySymbol, isAnyMarketOpen };