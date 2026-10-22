// Supabase connection. The publishable key is safe to ship in a browser;
// row-level security in the database decides what each user can see.
window.EMON_CONFIG = {
  // 2.2.1: the Supabase project EMON OVERRUNS in Singapore (ap-southeast-1), organization EMON HASAN
  supabaseUrl: "https://cvmqjerbbejvmzypbawi.supabase.co",
  supabaseKey: "sb_publishable_z7RMQOs1KiLuiAfOJvqFxA_k793EDQO",
  // 3.25: the Edge Function that checks the ID card + PIN (the code of supabase/functions/card-login), by its name in Supabase
  cardLoginFunction: "super-api",
  company: {
    name: "EMON OVERRUNS",
    // 2.2: the address is the city only, and no phone number is shown anywhere (screens, prints and PDFs)
    address: ["Pasay City, Metro Manila"],
    email: "emonoverruns@gmail.com",
    director: "Emon Hasan, Managing Director",
    // every printed page carries a small QR of the website: scanning it opens this address
    website: "https://emonoverruns.online"
  }
};
