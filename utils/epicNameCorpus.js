// Small, common US name pool used by utils/epicIdentityFactory.js to build
// plausible fake identities for Epic Games signups. Kept intentionally small
// — 200×200 gives 40k unique pairings, plenty for the volume this project
// will ever do, and keeps the file bundle-friendly. Sourced from US Social
// Security popular-baby-names dumps and Census surname frequency tables (all
// public-domain, non-copyrightable data).
//
// Editing rule: never remove names, only append. Downstream sessions
// reference identities by name; churn here would just add noise.

const firstNames = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
  "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark",
  "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth", "Kevin", "Brian",
  "George", "Timothy", "Ronald", "Jason", "Edward", "Jeffrey", "Ryan", "Jacob",
  "Gary", "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott",
  "Brandon", "Benjamin", "Samuel", "Gregory", "Frank", "Alexander", "Raymond",
  "Patrick", "Jack", "Dennis", "Jerry", "Tyler", "Aaron", "Jose", "Adam",
  "Nathan", "Henry", "Douglas", "Zachary", "Peter", "Kyle", "Walter", "Ethan",
  "Jeremy", "Harold", "Keith", "Christian", "Roger", "Noah", "Gerald", "Carl",
  "Terry", "Sean", "Austin", "Arthur", "Lawrence", "Jesse", "Dylan", "Bryan",
  "Joe", "Jordan", "Billy", "Bruce", "Albert", "Willie", "Gabriel", "Logan",
  "Alan", "Juan", "Wayne", "Roy", "Ralph", "Randy", "Eugene", "Vincent",
  "Russell", "Elijah", "Louis", "Bobby", "Philip", "Johnny",
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan",
  "Jessica", "Sarah", "Karen", "Nancy", "Lisa", "Betty", "Margaret", "Sandra",
  "Ashley", "Kimberly", "Emily", "Donna", "Michelle", "Carol", "Amanda",
  "Melissa", "Deborah", "Stephanie", "Rebecca", "Sharon", "Laura", "Cynthia",
  "Kathleen", "Amy", "Angela", "Shirley", "Anna", "Brenda", "Pamela", "Emma",
  "Nicole", "Helen", "Samantha", "Katherine", "Christine", "Debra", "Rachel",
  "Carolyn", "Janet", "Catherine", "Maria", "Heather", "Diane", "Ruth",
  "Julie", "Olivia", "Joyce", "Virginia", "Victoria", "Kelly", "Lauren",
  "Christina", "Joan", "Evelyn", "Judith", "Andrea", "Hannah", "Megan",
  "Cheryl", "Jacqueline", "Martha", "Madison", "Teresa", "Gloria", "Sara",
  "Janice", "Ann", "Kathryn", "Abigail", "Sophia", "Frances", "Jean", "Alice",
  "Judy", "Isabella", "Julia", "Grace", "Amber", "Denise", "Danielle",
  "Marilyn", "Beverly", "Charlotte", "Natalie", "Theresa", "Diana", "Brittany",
  "Doris", "Kayla", "Alexis", "Lori", "Marie", "Ella", "Aria", "Zoe",
  "Chloe", "Layla", "Riley", "Ava",
];

const lastNames = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson",
  "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee",
  "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez",
  "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott",
  "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams", "Nelson", "Baker",
  "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts", "Gomez",
  "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins",
  "Reyes", "Stewart", "Morris", "Morales", "Murphy", "Cook", "Rogers", "Gutierrez",
  "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey", "Reed", "Kelly", "Howard",
  "Ramos", "Kim", "Cox", "Ward", "Richardson", "Watson", "Brooks", "Chavez",
  "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes", "Price",
  "Alvarez", "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross", "Foster",
  "Jimenez", "Powell", "Jenkins", "Perry", "Russell", "Sullivan", "Bell",
  "Coleman", "Butler", "Henderson", "Barnes", "Gonzales", "Fisher", "Vasquez",
  "Simmons", "Romero", "Jordan", "Patterson", "Alexander", "Hamilton", "Graham",
  "Reynolds", "Griffin", "Wallace", "Moreno", "West", "Cole", "Hayes", "Bryant",
  "Herrera", "Gibson", "Ellis", "Tran", "Medina", "Aguilar", "Stevens", "Murray",
  "Ford", "Castro", "Marshall", "Owens", "Harrison", "Fernandez", "McDonald",
  "Woods", "Washington", "Kennedy", "Wells", "Vargas", "Henry", "Chen",
  "Freeman", "Webb", "Tucker", "Guzman", "Burns", "Crawford", "Olson",
  "Simpson", "Porter", "Hunter", "Gordon", "Mendez", "Silva", "Shaw", "Snyder",
  "Mason", "Dixon", "Munoz", "Hunt", "Hicks", "Holmes", "Palmer", "Wagner",
  "Black", "Robertson", "Boyd", "Rose", "Stone", "Salazar", "Fox", "Warren",
  "Mills", "Meyer", "Rice", "Schmidt", "Garza", "Daniels", "Ferguson", "Nichols",
  "Stephens", "Soto", "Weaver", "Ryan", "Gardner", "Payne", "Grant", "Dunn",
  "Kelley", "Spencer", "Hawkins", "Arnold", "Pierce", "Vazquez", "Hansen",
  "Peters", "Santos", "Hart",
];

module.exports = { firstNames, lastNames };
