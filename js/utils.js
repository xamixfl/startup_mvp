/**
 * Automatically sync cities from meetings and profiles to cities table
 */
async function syncCities() {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};
  
  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return { success: false, error: 'Configuration missing' };
  }

  try {
    console.log('Starting cities sync...');
    
    // Fetch all locations from meetings
    const { data: meetings, error: meetingsError } = await supabaseClient
      .from(TABLES.meetings)
      .select('location');
    
    if (meetingsError) throw meetingsError;

    // Fetch all locations from profiles
    const { data: profiles, error: profilesError } = await supabaseClient
      .from(TABLES.profiles)
      .select('location');
    
    if (profilesError) throw profilesError;

    // Extract unique city names (filter out null/empty values)
    const citySet = new Set();
    
    meetings?.forEach(m => {
      if (m.location && m.location.trim()) {
        citySet.add(m.location.trim());
      }
    });
    
    profiles?.forEach(p => {
      if (p.location && p.location.trim()) {
        citySet.add(p.location.trim());
      }
    });

    const uniqueCities = Array.from(citySet);
    console.log(`Found ${uniqueCities.length} unique cities:`, uniqueCities);

    if (uniqueCities.length === 0) {
      console.log('No cities to sync');
      return { success: true, count: 0 };
    }

    // Insert cities (upsert to avoid duplicates)
    const cityRecords = uniqueCities.map(name => ({ name }));
    
    const { data, error } = await supabaseClient
      .from(TABLES.cities)
      .upsert(cityRecords, { 
        onConflict: 'name',
        ignoreDuplicates: false 
      })
      .select();

    if (error) throw error;

    console.log(`Successfully synced ${uniqueCities.length} cities to database`);
    return { success: true, count: uniqueCities.length, cities: uniqueCities };

  } catch (error) {
    console.error('Error syncing cities:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Add a single city to the cities table
 */
async function addCity(cityName) {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};
  
  if (!supabaseClient || !TABLES || !cityName || !cityName.trim()) {
    return { success: false };
  }

  try {
    const { data, error } = await supabaseClient
      .from(TABLES.cities)
      .upsert([{ name: cityName.trim() }], { 
        onConflict: 'name',
        ignoreDuplicates: true 
      })
      .select();

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error adding city:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch all topics from the database
 */
async function fetchTopics() {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};
  
  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return [];
  }

  try {
    const { data, error } = await supabaseClient
      .from(TABLES.topics)
      .select('*')
      .order('name', { ascending: true });
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching topics:', error);
    return [];
  }
}

/**
 * Fetch all cities from the database
 */
async function fetchCities() {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};
  
  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return [];
  }

  try {
    const { data, error } = await supabaseClient
      .from(TABLES.cities)
      .select('*')
      .order('name', { ascending: true });
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching cities:', error);
    return [];
  }
}

// Make functions globally available
window.syncCities = syncCities;
window.addCity = addCity;
window.fetchTopics = fetchTopics;
window.fetchCities = fetchCities;
