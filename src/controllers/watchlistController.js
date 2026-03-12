// backend/src/controllers/watchlistController.js
const { supabase } = require('../config/supabase');

// Get all watchlists
exports.getWatchlists = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: watchlists, error } = await supabase
      .from('watchlists')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: watchlists || [],
    });
  } catch (error) {
    console.error('Get watchlists error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch watchlists',
    });
  }
};

// Create watchlist
exports.createWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, isDefault = false } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Watchlist name is required',
      });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await supabase
        .from('watchlists')
        .update({ is_default: false })
        .eq('user_id', userId);
    }

    // Create watchlist
    const { data: watchlist, error } = await supabase
      .from('watchlists')
      .insert({
        user_id: userId,
        name: name.trim(),
        is_default: isDefault,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: watchlist,
      message: 'Watchlist created successfully',
    });
  } catch (error) {
    console.error('Create watchlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create watchlist',
    });
  }
};

// Rename watchlist
exports.renameWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'New name is required',
      });
    }

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Update name
    const { data: updatedWatchlist, error } = await supabase
      .from('watchlists')
      .update({
        name: name.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', watchlistId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: updatedWatchlist,
      message: 'Watchlist renamed successfully',
    });
  } catch (error) {
    console.error('Rename watchlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to rename watchlist',
    });
  }
};

// Delete watchlist
exports.deleteWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Prevent deleting default watchlist
    if (watchlist.is_default) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete default watchlist',
      });
    }

    // Check if it's the only watchlist
    const { data: allWatchlists } = await supabase
      .from('watchlists')
      .select('id')
      .eq('user_id', userId);

    if (allWatchlists && allWatchlists.length <= 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the only watchlist',
      });
    }

    // Delete symbols first
    await supabase
      .from('watchlist_symbols')
      .delete()
      .eq('watchlist_id', watchlistId);

    // Delete watchlist
    const { error } = await supabase
      .from('watchlists')
      .delete()
      .eq('id', watchlistId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Watchlist deleted successfully',
    });
  } catch (error) {
    console.error('Delete watchlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete watchlist',
    });
  }
};

// Set default watchlist
exports.setDefaultWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Unset all defaults
    await supabase
      .from('watchlists')
      .update({ is_default: false })
      .eq('user_id', userId);

    // Set this as default
    const { data: updatedWatchlist, error } = await supabase
      .from('watchlists')
      .update({
        is_default: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', watchlistId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: updatedWatchlist,
      message: 'Default watchlist updated',
    });
  } catch (error) {
    console.error('Set default watchlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set default watchlist',
    });
  }
};

// Get watchlist symbols
exports.getWatchlistSymbols = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Get symbols
    const { data: symbols, error } = await supabase
      .from('watchlist_symbols')
      .select('symbol, sort_order, added_at')
      .eq('watchlist_id', watchlistId)
      .order('sort_order', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: symbols || [],
    });
  } catch (error) {
    console.error('Get watchlist symbols error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch symbols',
    });
  }
};

// Add symbol to watchlist
exports.addSymbol = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'Symbol is required',
      });
    }

    const normalizedSymbol = symbol.toUpperCase().trim();

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Check if symbol already exists
    const { data: existing } = await supabase
      .from('watchlist_symbols')
      .select('id')
      .eq('watchlist_id', watchlistId)
      .eq('symbol', normalizedSymbol)
      .single();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Symbol already in watchlist',
      });
    }

    // Verify symbol exists
    const { data: symbolData, error: symbolError } = await supabase
      .from('symbols')
      .select('symbol')
      .eq('symbol', normalizedSymbol)
      .single();

    if (symbolError || !symbolData) {
      return res.status(404).json({
        success: false,
        message: 'Symbol not found',
      });
    }

    // Get max sort order
    const { data: maxOrder } = await supabase
      .from('watchlist_symbols')
      .select('sort_order')
      .eq('watchlist_id', watchlistId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();

    const sortOrder = (maxOrder?.sort_order || 0) + 1;

    // Add symbol
    const { data: watchlistSymbol, error } = await supabase
      .from('watchlist_symbols')
      .insert({
        watchlist_id: watchlistId,
        symbol: normalizedSymbol,
        sort_order: sortOrder,
        added_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: watchlistSymbol,
      message: 'Symbol added to watchlist',
    });
  } catch (error) {
    console.error('Add symbol error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add symbol',
    });
  }
};

// Remove symbol from watchlist
exports.removeSymbol = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId, symbol } = req.params;

    const normalizedSymbol = symbol.toUpperCase().trim();

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Remove symbol
    const { error } = await supabase
      .from('watchlist_symbols')
      .delete()
      .eq('watchlist_id', watchlistId)
      .eq('symbol', normalizedSymbol);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Symbol removed from watchlist',
    });
  } catch (error) {
    console.error('Remove symbol error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove symbol',
    });
  }
};

// Reorder symbols
exports.reorderSymbols = async (req, res) => {
  try {
    const userId = req.user.id;
    const { watchlistId } = req.params;
    const { symbols } = req.body; // Array of symbols in new order

    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        message: 'Symbols array is required',
      });
    }

    // Verify ownership
    const { data: watchlist, error: fetchError } = await supabase
      .from('watchlists')
      .select('*')
      .eq('id', watchlistId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found',
      });
    }

    // Update sort order for each symbol
    for (let i = 0; i < symbols.length; i++) {
      await supabase
        .from('watchlist_symbols')
        .update({ sort_order: i })
        .eq('watchlist_id', watchlistId)
        .eq('symbol', symbols[i].toUpperCase());
    }

    res.json({
      success: true,
      message: 'Symbols reordered successfully',
    });
  } catch (error) {
    console.error('Reorder symbols error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reorder symbols',
    });
  }
};