// facility-map.mjs
// Mapping from RecTrac CSV "Facility" names -> array of board roomIds
// These roomIds match what the board UI expects in events.json

export const FACILITY_TO_ROOMS = {
  // ---------- Front cluster: 1A, 1B, 2A, 2B ----------

  // Appears for all four: 1A, 1B, 2A, 2B
  "AC Gym - Championship Court": ["1A", "1B", "2A", "2B"],

  // Also appears for all four: 1A, 1B, 2A, 2B
  "AC Gym - Full Gym 1AB & 2AB": ["1A", "1B", "2A", "2B"],

  // Shared courts
  "AC Gym - Court 1-AB": ["1A", "1B"],
  "AC Gym - Court 2-AB": ["2A", "2B"],

  // Half courts (1:1)
  "AC Gym - Half Court 1A": ["1A"],
  "AC Gym - Half Court 1B": ["1B"],
  "AC Gym - Half Court 2A": ["2A"],
  "AC Gym - Half Court 2B": ["2B"],

  // ---------- Fieldhouse courts: 3–8 ----------

  // Season marker / aggregate: appears for all 3–8, but you already
  // get specific "AC Fieldhouse - Court X" rows, so we ignore this
  // to avoid duplicates on the board:
  "AC Fieldhouse Court 3-8": [],

  "AC Fieldhouse - Court 3": ["3"],
  "AC Fieldhouse - Court 4": ["4"],
  "AC Fieldhouse - Court 5": ["5"],
  "AC Fieldhouse - Court 6": ["6"],
  "AC Fieldhouse - Court 7": ["7"],
  "AC Fieldhouse - Court 8": ["8"],

  // ---------- Turf quarters: NA / NB / SA / SB ----------

  // Full turf = all four quarters
  "AC Fieldhouse - Full Turf": [
    "Quarter Turf NA",
    "Quarter Turf NB",
    "Quarter Turf SA",
    "Quarter Turf SB",
  ],

  // Half north = NA + NB
  "AC Fieldhouse - Half Turf North": [
    "Quarter Turf NA",
    "Quarter Turf NB",
  ],

  // Half south = SA + SB
  "AC Fieldhouse - Half Turf South": [
    "Quarter Turf SA",
    "Quarter Turf SB",
  ],

  // Quarter bookings (1:1)
  "AC Fieldhouse - Quarter Turf NA": ["Quarter Turf NA"],
  "AC Fieldhouse - Quarter Turf NB": ["Quarter Turf NB"],
  "AC Fieldhouse - Quarter Turf SA": ["Quarter Turf SA"],
  "AC Fieldhouse - Quarter Turf SB": ["Quarter Turf SB"],

  // ---------- Back cluster: 9A, 9B, 10A, 10B ----------

  // North (9/10) examples inside FACILITY_TO_ROOMS:
"AC Gym - Half Court 9A": ["9A"],
"AC Gym - Half Court 9B": ["9B"],

// Anchor 9-AB to 9A only
"AC Gym - Court 9-AB": ["9A"],

"AC Gym - Half Court 10A": ["10A"],
"AC Gym - Half Court 10B": ["10B"],

// Anchor 10-AB to 10A only
"AC Gym - Court 10-AB": ["10A"],

// Full Gym 9 & 10 anchored to 10A only
"AC Gym - Full Gym 9 & 10": ["10A"],
};
