// Supabase connection. The publishable key is safe to ship in a browser;
// row-level security in the database decides what each user can see.
window.EMON_CONFIG = {
  supabaseUrl: "https://mgwqjjkwonhzrfndkray.supabase.co",
  supabaseKey: "sb_publishable_y7G4MCGyfZOKQs-yS5KmXQ_Xk1R13-2",
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
