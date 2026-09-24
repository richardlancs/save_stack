// Seeded synthetic library generator for benchmarks and precision tests.
// Deterministic: same (count, seed) => byte-identical output.
//
// Realism goals (from the brief, §9): multilingual captions, emoji, skewed counts,
// Zipf-distributed authors, many-to-many collection membership, and -- importantly --
// a large share of videos that belong to a category WITHOUT ever using the category
// word itself (a pasta video that never says "food"). That is the case the
// related-terms layer exists for, so the generator must produce it.

export interface Category {
  key: string;
  /** Words users would type as a chip ("food"). Some captions omit these on purpose. */
  core: string[];
  /** Words that signal the category without naming it. */
  related: string[];
  tags: string[];
  /** Name of the collection this category mostly lands in. */
  collection: string;
}

export const CATEGORIES: Category[] = [
  { key: 'food', core: ['food', 'foodie'], related: ['recipe', 'recipes', 'cooking', 'meal', 'dinner', 'lunch', 'breakfast', 'pasta', 'baking', 'chicken', 'vegan', 'snack', 'dessert', 'airfryer'], tags: ['foodtok', 'recipe', 'easyrecipes', 'cooking', 'mealprep', 'dinnerideas'], collection: 'Recipes' },
  { key: 'makeup', core: ['makeup'], related: ['grwm', 'foundation', 'lipstick', 'eyeshadow', 'mascara', 'blush', 'contour', 'concealer', 'eyeliner', 'beauty'], tags: ['makeuptutorial', 'grwm', 'beautytok', 'makeuphacks'], collection: 'Makeup looks' },
  { key: 'fitness', core: ['fitness', 'workout'], related: ['gym', 'squat', 'abs', 'cardio', 'hiit', 'protein', 'lifting', 'stretch', 'pilates', 'reps'], tags: ['gymtok', 'workout', 'fitnessmotivation', 'pilates'], collection: 'Workouts' },
  { key: 'travel', core: ['travel'], related: ['trip', 'flight', 'hotel', 'itinerary', 'beach', 'hiking', 'passport', 'airport', 'roadtrip', 'hostel'], tags: ['traveltok', 'wanderlust', 'traveltips', 'budgettravel'], collection: 'Travel bucket list' },
  { key: 'fashion', core: ['fashion', 'outfit'], related: ['ootd', 'style', 'thrift', 'jeans', 'dress', 'sneakers', 'streetwear', 'capsule', 'lookbook', 'haul'], tags: ['ootd', 'fashiontok', 'thrifted', 'outfitideas'], collection: 'Outfits' },
  { key: 'skincare', core: ['skincare'], related: ['serum', 'moisturizer', 'sunscreen', 'retinol', 'cleanser', 'acne', 'toner', 'spf', 'routine', 'glow'], tags: ['skincaretok', 'skincareroutine', 'glowup', 'acnetips'], collection: 'Skincare' },
  { key: 'diy', core: ['diy'], related: ['craft', 'build', 'woodworking', 'upcycle', 'handmade', 'paint', 'sewing', 'crochet', 'knitting', 'project'], tags: ['diyproject', 'crafttok', 'upcycling', 'handmade'], collection: 'DIY projects' },
  { key: 'homedecor', core: ['decor', 'home'], related: ['apartment', 'shelf', 'organize', 'declutter', 'furniture', 'cozy', 'lighting', 'rug', 'kitchen', 'bedroom'], tags: ['homedecor', 'apartmenttherapy', 'organization', 'roomtour'], collection: 'Home ideas' },
  { key: 'pets', core: ['pets', 'pet'], related: ['dog', 'puppy', 'cat', 'kitten', 'vet', 'leash', 'treats', 'adopt', 'hamster', 'aquarium'], tags: ['dogsoftiktok', 'cattok', 'petcare', 'puppytraining'], collection: 'Pets' },
  { key: 'tech', core: ['tech'], related: ['iphone', 'android', 'laptop', 'ai', 'chatgpt', 'app', 'gadget', 'setup', 'keyboard', 'coding'], tags: ['techtok', 'gadgets', 'productivityapps', 'codingtips'], collection: 'Tech' },
  { key: 'finance', core: ['finance', 'money'], related: ['budget', 'savings', 'invest', 'stocks', 'credit', 'debt', 'salary', 'roth', 'rent', 'frugal'], tags: ['moneytok', 'personalfinance', 'investing', 'budgeting'], collection: 'Money' },
  { key: 'study', core: ['study'], related: ['notes', 'exam', 'flashcards', 'college', 'thesis', 'productivity', 'pomodoro', 'lecture', 'planner', 'homework'], tags: ['studytok', 'studytips', 'college', 'productivity'], collection: 'Study' },
  { key: 'comedy', core: ['funny', 'comedy'], related: ['skit', 'lol', 'relatable', 'pov', 'meme', 'joke', 'prank', 'humor', 'sketch', 'awkward'], tags: ['funny', 'comedy', 'relatable', 'skit'], collection: 'Funny' },
  { key: 'music', core: ['music'], related: ['song', 'guitar', 'piano', 'cover', 'lyrics', 'playlist', 'singing', 'beat', 'producer', 'concert'], tags: ['musictok', 'guitarcover', 'newmusic', 'singersoftiktok'], collection: 'Music' },
  { key: 'hair', core: ['hair'], related: ['curls', 'braids', 'haircut', 'balayage', 'blowout', 'bangs', 'ponytail', 'shampoo', 'updo', 'layers'], tags: ['hairtok', 'hairtutorial', 'curlyhair', 'hairstyle'], collection: 'Hair' },
];

const CATCH_ALL_COLLECTIONS = ['Favorites', 'Watch later', 'Ideas', 'To try', 'Inspo'];

const FILLER = ('this is so good you need to try the best way how my favorite for when easy quick simple perfect ever today tips hack trick ' +
  'day life in with and of new must have love obsessed viral trending step by guide check out part one two three every single time ' +
  'honestly literally actually finally never knew until now save this for later wait for it').split(' ');

const NON_EN: { lang: string; phrases: string[] }[] = [
  { lang: 'es', phrases: ['receta fácil para la cena', 'maquillaje para principiantes', 'rutina de ejercicios en casa', 'viajes baratos', 'ideas para el hogar', 'cuidado de la piel'] },
  { lang: 'ja', phrases: ['簡単レシピ', 'メイク動画', '筋トレメニュー', '国内旅行おすすめ', '猫かわいい', '勉強法まとめ', '100均diy'] },
  { lang: 'pt', phrases: ['receita fácil', 'dicas de maquiagem', 'treino em casa', 'viagem barata'] },
];
const EMOJI = ['🔥', '😂', '✨', '💕', '🍝', '💄', '🏋️', '✈️', '🐶', '🤯'];
const SYLLABLES = ['ka', 'mi', 'lo', 'ren', 'sa', 'do', 'vi', 'na', 'te', 'jo', 'be', 'ru', 'an', 'el', 'zo', 'ma', 'ti', 'ky'];
const SOUND_WORDS = ['midnight', 'summer', 'dreams', 'sunset', 'echo', 'fire', 'gold', 'neon', 'river', 'static', 'velvet', 'paper', 'orbit'];

export interface SynthCollection { id: number; externalId: string; name: string }
export interface SynthItem {
  id: number;
  externalId: string;
  url: string;
  authorHandle: string;
  authorName: string;
  caption: string;
  hashtags: string[];
  soundTitle: string;
  soundAuthor: string;
  durationSec: number;
  postedAt: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  thumbnailUrl: string;
  language: string;
  firstSeenAt: number;
  /** Ground truth (not stored in the DB): the category this video was generated for. */
  category: string;
  /** True if the caption/hashtags contain a core word for the category (i.e. a direct chip hit). */
  hasCoreWord: boolean;
  collectionIds: number[];
}
export interface SynthLibrary { items: SynthItem[]; collections: SynthCollection[] }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function zipfCdf(n: number, s: number): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = 1; i <= n; i++) { const x = 1 / Math.pow(i, s); w.push(x); sum += x; }
  let acc = 0;
  return w.map((x) => (acc += x / sum));
}

export function generateLibrary(count: number, seed = 1337, nowMs = Date.UTC(2026, 8, 1)): SynthLibrary {
  const rnd = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const sampleCdf = (cdf: number[]): number => {
    const r = rnd();
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid]! < r) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const lognormal = (mu: number, sigma: number) => Math.exp(mu + sigma * gauss());

  const collections: SynthCollection[] = [];
  const collectionByName = new Map<string, number>();
  const addCollection = (name: string) => {
    const id = collections.length + 1;
    collections.push({ id, externalId: `col_${id}`, name });
    collectionByName.set(name, id);
  };
  for (const c of CATEGORIES) addCollection(c.collection);
  for (const n of CATCH_ALL_COLLECTIONS) addCollection(n);

  const nAuthors = Math.max(50, Math.floor(count / 15));
  const authors: { handle: string; name: string }[] = [];
  for (let i = 0; i < nAuthors; i++) {
    const handle = pick(SYLLABLES) + pick(SYLLABLES) + pick(SYLLABLES) + String(Math.floor(rnd() * 900) + 100);
    authors.push({ handle, name: handle[0]!.toUpperCase() + handle.slice(1) });
  }
  const authorCdf = zipfCdf(nAuthors, 1.05);
  const categoryCdf = zipfCdf(CATEGORIES.length, 0.7);
  const nSounds = Math.max(50, Math.floor(count / 25));

  // Long tail: real captions/hashtags have tens of thousands of distinct rare tokens. A tiny vocabulary
  // makes FTS doclists unrealistically dense and flatters every benchmark, so add a Zipf-distributed tail.
  const mkWord = (min: number, max: number) => {
    let w = '';
    const len = min + Math.floor(rnd() * (max - min + 1));
    while (w.length < len) w += pick(SYLLABLES);
    return w.slice(0, len);
  };
  const nTailWords = Math.max(2000, Math.floor(count * 0.6));
  const nTailTags = Math.max(1000, Math.floor(count * 0.4));
  const tailWords = Array.from({ length: nTailWords }, () => mkWord(4, 9));
  const tailTags = Array.from({ length: nTailTags }, () => mkWord(5, 12));
  const tailWordCdf = zipfCdf(nTailWords, 1.0);
  const tailTagCdf = zipfCdf(nTailTags, 1.0);

  const items: SynthItem[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const cat = CATEGORIES[sampleCdf(categoryCdf)]!;
    const author = authors[sampleCdf(authorCdf)]!;
    const langRoll = rnd();
    let caption: string;
    let hashtags: string[] = [];
    let language = 'en';
    let hasCoreWord = false;

    if (langRoll < 0.88) {
      const useCore = rnd() < 0.6; // 40% of English captions never say the category word
      const n = 5 + Math.floor(rnd() * 12);
      const words: string[] = [];
      for (let k = 0; k < n; k++) {
        const r = rnd();
        if (useCore && r < 0.16) { words.push(pick(cat.core)); hasCoreWord = true; }
        else if (r < 0.5) words.push(pick(cat.related));
        else words.push(pick(FILLER));
      }
      if (rnd() < 0.25) { const c2 = pick(CATEGORIES); for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) words.push(pick(c2.related)); }
      if (rnd() < 0.1) words.push(pick(EMOJI));
      for (let k = 0, n2 = 1 + Math.floor(rnd() * 4); k < n2; k++) words.push(tailWords[sampleCdf(tailWordCdf)]!);
      const nTags = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < nTags; k++) {
        const r = rnd();
        const t = r < 0.65 ? pick(cat.tags) : r < 0.85 ? pick(['fyp', 'foryou', 'viral', 'trending', 'tiktok']) : pick(pick(CATEGORIES).tags);
        if (!hashtags.includes(t)) hashtags.push(t);
      }
      if (rnd() < 0.7) { const t = tailTags[sampleCdf(tailTagCdf)]!; if (!hashtags.includes(t)) hashtags.push(t); }
      if (rnd() < 0.25) { const t = tailTags[sampleCdf(tailTagCdf)]!; if (!hashtags.includes(t)) hashtags.push(t); }
      if (hashtags.some((t) => cat.core.some((w) => t.includes(w)))) hasCoreWord = true;
      caption = words.join(' ') + ' ' + hashtags.map((t) => '#' + t).join(' ');
    } else {
      const grp = pick(NON_EN);
      language = grp.lang;
      caption = pick(grp.phrases) + ' ' + pick(EMOJI);
      hashtags = rnd() < 0.5 ? [pick(['fyp', 'viral', 'おすすめ', 'parati'])] : [];
      if (hashtags.length) caption += ' #' + hashtags[0];
    }

    // membership: mostly the category's collection, sometimes a catch-all, sometimes several.
    const memberOf = new Set<number>();
    memberOf.add(rnd() < 0.75 ? collectionByName.get(cat.collection)! : collectionByName.get(pick(CATCH_ALL_COLLECTIONS))!);
    if (rnd() < 0.3) memberOf.add(collectionByName.get(pick(CATCH_ALL_COLLECTIONS))!);
    if (rnd() < 0.05) memberOf.add(collectionByName.get(pick(CATCH_ALL_COLLECTIONS))!);

    const views = Math.max(50, Math.round(lognormal(9.8, 1.9)));
    const likes = Math.round(views * (0.03 + rnd() * 0.12));
    const soundOriginal = rnd() < 0.6;
    const externalId = String(7000000000000000000n + BigInt(i) * 7919n + BigInt(Math.floor(rnd() * 1000)));
    items.push({
      id,
      externalId,
      url: `https://www.tiktok.com/@${author.handle}/video/${externalId}`,
      authorHandle: author.handle,
      authorName: author.name,
      caption,
      hashtags,
      soundTitle: soundOriginal ? `original sound - ${author.handle}` : `${pick(SOUND_WORDS)} ${pick(SOUND_WORDS)} ${Math.floor(rnd() * nSounds)}`,
      soundAuthor: soundOriginal ? author.handle : pick(SYLLABLES) + pick(SYLLABLES),
      durationSec: Math.max(3, Math.round(lognormal(3.3, 0.8))),
      postedAt: nowMs - Math.floor(rnd() * 3 * 365 * 86400000),
      views,
      likes,
      comments: Math.round(likes * (0.01 + rnd() * 0.05)),
      shares: Math.round(likes * (0.01 + rnd() * 0.08)),
      saves: Math.round(likes * (0.02 + rnd() * 0.15)),
      thumbnailUrl: `https://p16.example.invalid/obj/${id}~tplv-cover.jpeg?x-expires=${Math.floor(nowMs / 1000)}`,
      language,
      firstSeenAt: nowMs - i, // earlier index = saved more recently
      category: cat.key,
      hasCoreWord,
      collectionIds: [...memberOf],
    });
  }
  return { items, collections };
}
