// Deterministic voice commands for Live Mode. Confirmation is decided here in code, never by the model (D3).
import { normalizeYesNo } from './normalize';
import type { FieldType, Language } from './types';

export type VoiceCommand = 'confirm' | 'reject' | 'repeat' | 'next' | 'previous' | 'skip' | 'explain' | 'stop';

// English, Hindi (Devanagari and romanised) and Marathi. Whole-utterance matches only.
const COMMANDS: [VoiceCommand, RegExp][] = [
  ['confirm', /^((yes|yeah|yep|yup|sure|correct|right|exactly|perfect)( (it is|that'?s (right|correct)|please|correct|confirm))?|that'?s (right|correct|it)|it'?s (right|correct)|confirm( it)?|ok(ay)?|haan( ji)?|haa|ji haan|haan sahi hai|sahi( hai)?|theek( hai)?|bilkul|हाँ( जी)?|हां( जी)?|जी हाँ|जी हां|जी|सही( है)?|हाँ सही है|हां सही है|ठीक( है)?|बिल्कुल|ho|hoy|barobar|हो|होय|बरोबर( आहे)?|ठीक आहे|चालेल|हो बरोबर)$/],
  ['reject', /^(no|nope|wrong|incorrect|edit|change( it)?|that'?s wrong|nahi|nahin|galat|badlo|नहीं|ना|गलत|ग़लत|बदलो|बदलें|गलत है|नाही|चूक|चुकीचं|चुकीचे|बदला|नको|naahi|chuk)$/],
  ['repeat', /^(repeat|again|say (it )?again|pardon|sorry|what\??|come again|dobara|phir se|फिर से|दोबारा|दोहराओ|दोहराएँ|पुन्हा|परत सांगा|पुन्हा सांगा|punha)$/],
  ['next', /^(next|next question|go on|move on|aage|agla|आगे|अगला|अगला प्रश्न|पुढे|पुढचा|पुढचा प्रश्न|pudhe)$/],
  ['previous', /^(previous|back|go back|pichla|peeche|पिछला|पीछे|मागे|मागचा|mage)$/],
  ['skip', /^(skip|skip (it|this)|chhodo|chhod do|छोड़ो|छोड़ें|छोड़ दो|वगळा|सोडा|vagla)$/],
  ['explain', /^(explain|what does (this|that) mean\??|what is (this|that)\??|samjhao|samjhaiye|समझाओ|समझाइए|समझाएँ|मतलब\??|इसका मतलब क्या है\??|समजावून सांगा|म्हणजे काय\??|याचा अर्थ काय\??)$/],
  ['stop', /^(stop|stop listening|pause|ruko|bas|रुको|बस|थांबा|थांब|thamba)$/],
];

// The other Indian languages, as whole phrases. The first word of each list is the one shown in hints.
const PHRASES: Record<Exclude<Language, 'en' | 'hi' | 'mr'>, Record<VoiceCommand, string[]>> = {
  bn: {
    confirm: ['হ্যাঁ', 'হাঁ', 'ঠিক আছে', 'ঠিক', 'সঠিক', 'হ্যাঁ ঠিক আছে'], reject: ['না', 'ভুল', 'বদলান', 'পাল্টান'],
    repeat: ['আবার', 'আবার বলুন', 'আরেকবার'], next: ['পরের', 'পরেরটা', 'পরবর্তী', 'এগিয়ে যান'], previous: ['আগের', 'আগেরটা', 'পিছনে'],
    skip: ['বাদ দিন', 'এড়িয়ে যান'], explain: ['বুঝিয়ে বলুন', 'মানে কী', 'এর মানে কী'], stop: ['থামুন', 'থামো', 'বন্ধ করুন'],
  },
  te: {
    confirm: ['అవును', 'సరే', 'సరైనది', 'కరెక్ట్'], reject: ['కాదు', 'లేదు', 'తప్పు', 'మార్చండి'],
    repeat: ['మళ్ళీ', 'మళ్ళీ చెప్పండి'], next: ['తర్వాత', 'తదుపరి', 'ముందుకు'], previous: ['వెనక్కి', 'ముందటిది'],
    skip: ['దాటవేయి', 'వదిలేయండి'], explain: ['వివరించండి', 'అర్థం ఏమిటి'], stop: ['ఆపు', 'ఆపండి'],
  },
  ta: {
    confirm: ['ஆம்', 'ஆமா', 'ஆமாம்', 'சரி', 'சரியானது'], reject: ['இல்லை', 'வேண்டாம்', 'தவறு', 'மாற்று'],
    repeat: ['மீண்டும்', 'திரும்ப சொல்லுங்கள்', 'மறுபடி'], next: ['அடுத்தது', 'அடுத்த கேள்வி', 'அடுத்து'], previous: ['முந்தையது', 'பின்னால்'],
    skip: ['தவிர்', 'விட்டுவிடு'], explain: ['விளக்குங்கள்', 'இதன் அர்த்தம் என்ன'], stop: ['நிறுத்து', 'நிறுத்துங்கள்'],
  },
  gu: {
    confirm: ['હા', 'હાં', 'બરાબર', 'ઠીક છે', 'સાચું'], reject: ['ના', 'ખોટું', 'બદલો'],
    repeat: ['ફરીથી', 'ફરી કહો'], next: ['આગળ', 'પછીનું', 'આગળનો પ્રશ્ન'], previous: ['પાછળ', 'પાછલું'],
    skip: ['છોડો', 'છોડી દો'], explain: ['સમજાવો', 'એનો અર્થ શું'], stop: ['રોકો', 'બસ', 'અટકો'],
  },
  ur: {
    confirm: ['ہاں', 'جی ہاں', 'جی', 'ٹھیک ہے', 'صحیح', 'درست'], reject: ['نہیں', 'غلط', 'بدلیں', 'بدلو'],
    repeat: ['دوبارہ', 'پھر سے'], next: ['اگلا', 'آگے', 'اگلا سوال'], previous: ['پچھلا', 'پیچھے'],
    skip: ['چھوڑیں', 'چھوڑ دو', 'چھوڑو'], explain: ['سمجھائیں', 'سمجھاؤ', 'مطلب کیا ہے'], stop: ['رکیں', 'رکو', 'بس'],
  },
  kn: {
    confirm: ['ಹೌದು', 'ಸರಿ', 'ಸರಿಯಾಗಿದೆ'], reject: ['ಇಲ್ಲ', 'ಬೇಡ', 'ತಪ್ಪು', 'ಬದಲಾಯಿಸಿ'],
    repeat: ['ಮತ್ತೆ', 'ಮತ್ತೊಮ್ಮೆ ಹೇಳಿ'], next: ['ಮುಂದೆ', 'ಮುಂದಿನದು', 'ಮುಂದಿನ ಪ್ರಶ್ನೆ'], previous: ['ಹಿಂದೆ', 'ಹಿಂದಿನದು'],
    skip: ['ಬಿಟ್ಟುಬಿಡಿ'], explain: ['ವಿವರಿಸಿ', 'ಇದರ ಅರ್ಥ ಏನು'], stop: ['ನಿಲ್ಲಿಸಿ'],
  },
  ml: {
    confirm: ['അതെ', 'ഉവ്വ്', 'ശരി', 'ശരിയാണ്'], reject: ['ഇല്ല', 'വേണ്ട', 'തെറ്റ്', 'മാറ്റുക'],
    repeat: ['വീണ്ടും', 'ഒന്നുകൂടി പറയൂ'], next: ['അടുത്തത്', 'അടുത്ത ചോദ്യം'], previous: ['പിന്നോട്ട്', 'മുമ്പത്തേത്'],
    skip: ['ഒഴിവാക്കുക'], explain: ['വിശദീകരിക്കുക', 'എന്താണ് അർത്ഥം'], stop: ['നിർത്തുക', 'നിർത്തൂ'],
  },
  pa: {
    confirm: ['ਹਾਂ', 'ਹਾਂਜੀ', 'ਹਾਂ ਜੀ', 'ਠੀਕ ਹੈ', 'ਸਹੀ'], reject: ['ਨਹੀਂ', 'ਗਲਤ', 'ਬਦਲੋ'],
    repeat: ['ਦੁਬਾਰਾ', 'ਫਿਰ ਤੋਂ'], next: ['ਅੱਗੇ', 'ਅਗਲਾ', 'ਅਗਲਾ ਸਵਾਲ'], previous: ['ਪਿੱਛੇ', 'ਪਿਛਲਾ'],
    skip: ['ਛੱਡੋ', 'ਛੱਡ ਦਿਓ'], explain: ['ਸਮਝਾਓ', 'ਇਸਦਾ ਮਤਲਬ ਕੀ ਹੈ'], stop: ['ਰੁਕੋ', 'ਬੱਸ'],
  },
  as: {
    confirm: ['হয়', 'হয়', 'ঠিক আছে', 'শুদ্ধ'], reject: ['নহয়', 'নহয়', 'নাই', 'ভুল', 'সলনি কৰক'],
    repeat: ['আকৌ', 'আকৌ কওক'], next: ['পৰৱৰ্তী', 'আগলৈ', 'পিছৰটো'], previous: ['আগৰটো', 'পিছলৈ'],
    skip: ['বাদ দিয়ক'], explain: ['বুজাই দিয়ক', 'অৰ্থ কি'], stop: ['ৰওক', 'বন্ধ কৰক'],
  },
  ne: {
    confirm: ['हो', 'हजुर', 'ठीक छ', 'सही छ'], reject: ['होइन', 'छैन', 'गलत', 'बदल्नुहोस्'],
    repeat: ['फेरि', 'फेरि भन्नुहोस्'], next: ['अर्को', 'अगाडि', 'अर्को प्रश्न'], previous: ['पछाडि', 'अघिल्लो'],
    skip: ['छोड्नुहोस्', 'छोड'], explain: ['बुझाउनुहोस्', 'यसको अर्थ के हो'], stop: ['रोक्नुहोस्', 'रोक', 'बस'],
  },
};

/** Matches a whole utterance (after trimming punctuation) to a command. Answers never match. */
export function parseVoiceCommand(utterance: string): VoiceCommand | null {
  const v = utterance.normalize('NFC').toLowerCase().trim().replace(/[.!?,।۔؟]+$/u, '').replace(/^(please|kripya|कृपया|कृपा करून) /, '').replace(/[,،]/g, '').replace(/\s+/g, ' ').trim();
  for (const [cmd, re] of COMMANDS) if (re.test(v)) return cmd;
  for (const lang of Object.values(PHRASES)) {
    for (const [cmd, list] of Object.entries(lang) as [VoiceCommand, string[]][]) if (list.includes(v)) return cmd;
  }
  return null;
}

/** The words to suggest in hints for a language: say “yes” to confirm, “next” to move on… */
export function commandWords(lang: Language): Record<'yes' | 'no' | 'next' | 'repeat' | 'explain', string> {
  if (lang === 'hi') return { yes: 'हाँ', no: 'नहीं', next: 'आगे', repeat: 'फिर से', explain: 'समझाओ' };
  if (lang === 'mr') return { yes: 'हो', no: 'नाही', next: 'पुढे', repeat: 'पुन्हा', explain: 'समजावून सांगा' };
  if (lang === 'en') return { yes: 'yes', no: 'no', next: 'next', repeat: 'repeat', explain: 'explain' };
  const p = PHRASES[lang];
  return { yes: p.confirm[0]!, no: p.reject[0]!, next: p.next[0]!, repeat: p.repeat[0]!, explain: p.explain[0]! };
}

/** Yes/no answers to a yes/no question must not be mistaken for confirmation of a *proposal*. */
export function isPlainYesNo(utterance: string): boolean {
  return normalizeYesNo(utterance) !== null;
}

/** Guesses a field type from a printed label (flat PDFs, AcroForm field names). The user can change it. */
export function guessFieldType(label: string): FieldType {
  const l = label.toLowerCase();
  if (/e-?mail|ईमेल/.test(l)) return 'email';
  if (/mobile|phone|contact no|फ़ोन|फोन|मोबाइल/.test(l)) return 'phone';
  if (/date|\bdob\b|d ?d ?\/ ?m ?m|जन्म तिथि|दिनांक|तारीख/.test(l)) return 'date';
  if (/\bage\b|percentage|number of|no\. of|pin ?code|पिन कोड|आयु/.test(l)) return 'number';
  if (/address|description|remarks|details|पता/.test(l)) return 'paragraph';
  return 'text';
}
