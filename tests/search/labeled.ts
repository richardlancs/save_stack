// A small hand-labeled library for measuring search quality. Written WITHOUT looking at the related-terms list:
// each caption is what a person might plausibly post, and `labels` is what a human would say the video is about.
// Some captions never contain the category word ("easy pasta carbonara" is food, but never says "food").
// Some are traps on purpose: keyword matching cannot tell "cooking up a surprise" from cooking, so they count as
// unavoidable false positives and the precision threshold is set with that in mind.
import type { SavedItem } from '../../src/core/model';

export type Label = 'food' | 'makeup' | 'fitness' | 'travel' | 'study' | 'pets' | 'tech' | 'gaming' | 'finance';

interface Row { caption: string; labels: Label[] }

const rows: Row[] = [
  // ---- food (12)
  { caption: 'easy pasta carbonara in 15 minutes #dinner #pasta', labels: ['food'] },
  { caption: 'meal prep sunday: chicken and rice bowls for the week #mealprep', labels: ['food'] },
  { caption: 'the crispiest air fryer chicken wings #airfryer #recipe', labels: ['food'] },
  { caption: 'homemade ramen from scratch, worth every hour #ramen', labels: ['food'] },
  { caption: '3 ingredient banana pancakes for breakfast #breakfast', labels: ['food'] },
  { caption: 'Korean fried chicken sauce you need to try #cooking #food', labels: ['food'] },
  { caption: "how I make my grandma's soup #soup #homemade", labels: ['food'] },
  { caption: 'sushi rolls at home for beginners #sushi', labels: ['food'] },
  { caption: 'the best smash burger technique #burger #grill', labels: ['food'] },
  { caption: 'sheet pan salmon dinner ready in 20 min #dinnerideas', labels: ['food'] },
  { caption: 'trying the viral tacos from the taco truck #tacos #food', labels: ['food'] },
  { caption: "lunch ideas for work that aren't sad salads #lunch #salad", labels: ['food'] },
  // ---- makeup (10)
  { caption: 'grwm for date night, foundation + lipstick #grwm', labels: ['makeup'] },
  { caption: 'soft glam eyeshadow tutorial with mascara #makeuptutorial', labels: ['makeup'] },
  { caption: 'drugstore concealer that actually works #concealer', labels: ['makeup'] },
  { caption: 'blush placement for a lifted face #blush #contour', labels: ['makeup'] },
  { caption: 'my everyday five minute face #makeup', labels: ['makeup'] },
  { caption: 'sephora haul: lip gloss and setting spray #sephora', labels: ['makeup'] },
  { caption: 'winged eyeliner trick for hooded eyes #eyeliner', labels: ['makeup'] },
  { caption: 'full glam for a wedding guest #glam', labels: ['makeup'] },
  { caption: 'brow lamination at home #brows', labels: ['makeup'] },
  { caption: 'bronzer and highlighter for glowy cheeks #beauty', labels: ['makeup'] },
  // ---- fitness (10)
  { caption: 'leg day: squats, deadlifts and lunges #legday #gym', labels: ['fitness'] },
  { caption: '20 minute home workout no equipment #homeworkout', labels: ['fitness'] },
  { caption: 'how I got my abs, cardio and diet #fitness', labels: ['fitness'] },
  { caption: 'progressive overload explained for beginners #lifting', labels: ['fitness'] },
  { caption: 'pilates full body routine #pilates', labels: ['fitness'] },
  { caption: 'push pull legs split for muscle gain #bulking', labels: ['fitness'] },
  { caption: 'kettlebell swings for glutes #kettlebell', labels: ['fitness'] },
  { caption: 'hiit that torches calories in 10 minutes #hiit', labels: ['fitness'] },
  { caption: 'gym anxiety tips, just show up #gymtok', labels: ['fitness'] },
  { caption: 'calisthenics progressions: pull up to muscle up #calisthenics', labels: ['fitness'] },
  // ---- travel (10)
  { caption: '3 day itinerary for Lisbon: hostel + flights budget #travel', labels: ['travel'] },
  { caption: 'packing for two weeks in one carry on luggage #packing', labels: ['travel'] },
  { caption: 'best beaches in Thailand for a backpacking trip #beach', labels: ['travel'] },
  { caption: 'airport hacks for long layovers #layover', labels: ['travel'] },
  { caption: 'solo trip to Japan, my visa and passport tips #japan', labels: ['travel'] },
  { caption: 'weekend getaway hotel tour #hotel', labels: ['travel'] },
  { caption: 'road trip snacks and playlist #roadtrip', labels: ['travel'] },
  { caption: 'hiking the trail to the summit at sunrise #hiking', labels: ['travel'] },
  { caption: 'cruise ship cabin tour #cruise', labels: ['travel'] },
  { caption: 'what I spent on my vacation abroad #vacation', labels: ['travel'] },
  // ---- study (10)
  { caption: 'flashcards + pomodoro for finals week #studytok', labels: ['study'] },
  { caption: 'how I take notes for lectures, anki and notion #notetaking', labels: ['study'] },
  { caption: 'study with me: 2 hours, midterm tomorrow #studywithme', labels: ['study'] },
  { caption: 'essay writing tips for college freshmen #essay', labels: ['study'] },
  { caption: 'thesis writing routine #thesis', labels: ['study'] },
  { caption: 'how I got a 4.0 gpa, my homework schedule #gpa', labels: ['study'] },
  { caption: 'revision timetable for exams #revision', labels: ['study'] },
  { caption: 'organic chemistry textbook hacks #exam', labels: ['study'] },
  { caption: 'study motivation for a long semester #semester', labels: ['study'] },
  { caption: 'library study session vlog #study', labels: ['study'] },
  // ---- pets (8)
  { caption: 'training my puppy to sit and stay #puppytraining', labels: ['pets'] },
  { caption: 'golden retriever reacts to the vet #goldenretriever', labels: ['pets'] },
  { caption: 'cat tree i built for my kitten #cat', labels: ['pets'] },
  { caption: 'adopting a rescue dog changed my life #rescue', labels: ['pets'] },
  { caption: "my hamster's new cage setup #hamster", labels: ['pets'] },
  { caption: 'corgi zoomies at the dog park #corgi', labels: ['pets'] },
  { caption: "how to trim your cat's nails #cattok", labels: ['pets'] },
  { caption: 'aquarium setup for beginners #fishtank', labels: ['pets'] },
  // ---- tech (8)
  { caption: 'iphone 16 unboxing and first impressions #iphone', labels: ['tech'] },
  { caption: 'my desk setup with a mechanical keyboard #desksetup', labels: ['tech'] },
  { caption: 'chatgpt prompts that save me hours #chatgpt', labels: ['tech'] },
  { caption: 'macbook vs windows laptop for students #laptop', labels: ['tech'] },
  { caption: 'best budget earbuds under $50 #earbuds', labels: ['tech'] },
  { caption: 'python tutorial: build a discord bot #python', labels: ['tech'] },
  { caption: 'smartwatch review after 3 months #smartwatch', labels: ['tech'] },
  { caption: 'wifi tips to fix slow internet #wifi', labels: ['tech'] },
  // ---- gaming (6)
  { caption: 'elden ring boss no hit run #eldenring', labels: ['gaming'] },
  { caption: 'minecraft house build tutorial #minecraft', labels: ['gaming'] },
  { caption: 'valorant ranked clutch 1v4 #valorant', labels: ['gaming'] },
  { caption: 'nintendo switch games worth buying #nintendo', labels: ['gaming'] },
  { caption: 'speedrun world record attempt #speedrun', labels: ['gaming'] },
  { caption: 'pokemon card pulls #pokemon', labels: ['gaming'] },
  // ---- finance (6)
  { caption: 'how I saved my first 10k on a low salary #savings', labels: ['finance'] },
  { caption: 'roth ira explained for beginners #investing', labels: ['finance'] },
  { caption: 'credit score tips to boost 100 points #creditscore', labels: ['finance'] },
  { caption: 'budget with me: paycheck breakdown #budget', labels: ['finance'] },
  { caption: 'index fund vs individual stocks #etf', labels: ['finance'] },
  { caption: 'paying off debt fast, my debt free journey #debt', labels: ['finance'] },
  // ---- distractors: about none of the nine categories
  { caption: 'this dance is stuck in my head #dance', labels: [] },
  { caption: 'when the beat drops #comedy #skit', labels: [] },
  { caption: 'sunset timelapse from my balcony #sunset', labels: [] },
  { caption: 'outfit of the day, thrifted blazer #ootd', labels: [] },
  { caption: 'reading my favorite novel by the fire #booktok', labels: [] },
  { caption: 'guess the song challenge #music', labels: [] },
  { caption: 'diy candle making for beginners #diy', labels: [] },
  { caption: 'watching the sunrise from the car #vibes', labels: [] },
  { caption: 'prank on my roommate goes wrong #prank', labels: [] },
  { caption: 'mountain views from my window #nature', labels: [] },
  { caption: 'car meet this weekend, tuned mustang #cars', labels: [] },
  { caption: 'my cozy reading corner makeover #decor', labels: [] },
  // ---- traps: a keyword hits but a human would not file them there (unavoidable false positives)
  { caption: "cooking up a surprise for my boyfriend's birthday #gift", labels: [] },
  { caption: 'a study of the human brain: why we procrastinate #neuroscience', labels: [] },
  // ---- a legitimate multi-label item
  { caption: 'my dog is my gym buddy at the park #dogsoftiktok', labels: ['pets', 'fitness'] },
];

export const LABELED_ITEMS: Array<SavedItem & { labels: Label[] }> = rows.map((r, i) => ({
  platform: 'tiktok',
  externalId: `lab${i}`,
  authorHandle: `user${i % 9}`,
  authorName: `User ${i % 9}`,
  caption: r.caption,
  hashtags: [...r.caption.matchAll(/#(\w+)/g)].map((m) => m[1]!.toLowerCase()),
  soundTitle: 'original sound',
  soundAuthor: `user${i % 9}`,
  durationSec: 20,
  postedAt: 1_700_000_000_000 + i,
  stats: { views: 1000 + i },
  labels: r.labels,
}));

export const CHIP_LABELS: Label[] = ['food', 'makeup', 'fitness', 'travel', 'study', 'pets', 'tech', 'gaming', 'finance'];
