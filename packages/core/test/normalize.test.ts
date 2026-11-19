import { describe, expect, it } from 'vitest';
import {
  leadingYesNo, matchOption, matchOptions, normalizeDate, normalizeEmail, normalizeNumber, normalizePhone,
  normalizeTime, normalizeYesNo, toAsciiDigits,
} from '../src/normalize';

describe('normalizers', () => {
  it('converts Hindi digits', () => {
    expect(toAsciiDigits('१२/०३/२००१')).toBe('12/03/2001');
    expect(normalizeNumber('३५')).toBe('35');
    expect(normalizeNumber('1,200')).toBe('1200');
    expect(normalizeNumber('four')).toBeNull();
  });

  it('reads yes/no in English and Hindi', () => {
    expect(normalizeYesNo('हाँ')).toBe('Yes');
    expect(normalizeYesNo('Haan')).toBe('Yes');
    expect(normalizeYesNo('नहीं।')).toBe('No');
    expect(normalizeYesNo('maybe')).toBeNull();
  });

  it('parses dates day-first and with month names, never guessing', () => {
    expect(normalizeDate('12/03/2001')).toBe('2001-03-12');
    expect(normalizeDate('12 March 2001')).toBe('2001-03-12');
    expect(normalizeDate('१२ मार्च २००१')).toBe('2001-03-12');
    expect(normalizeDate('March 12th, 2001')).toBe('2001-03-12');
    expect(normalizeDate('2001-03-12')).toBe('2001-03-12');
    expect(normalizeDate('31/02/2001')).toBeNull();
    expect(normalizeDate('next tuesday')).toBeNull();
  });

  it('parses times and refuses ambiguous ones', () => {
    expect(normalizeTime('10:30 am')).toBe('10:30');
    expect(normalizeTime('2 pm')).toBe('14:00');
    expect(normalizeTime('5')).toBeNull();
  });

  it('normalizes phones and spoken emails', () => {
    expect(normalizePhone('98440 12345')).toBe('9844012345');
    expect(normalizePhone('+91 98440-12345')).toBe('+919844012345');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizeEmail('Ayush at the rate gmail dot com')).toBe('ayush@gmail.com');
    expect(normalizeEmail('kathon@example.com')).toBe('kathon@example.com');
  });

  it('matches options exactly or by unique prefix only', () => {
    expect(matchOption('sunday', ['Saturday', 'Sunday'])).toBe('Sunday');
    expect(matchOption('s', ['Saturday', 'Sunday'])).toBeNull();
    expect(matchOption('eye', ['Eye check-up', 'Dental'])).toBe('Eye check-up');
  });
});

describe('choosing options by voice', () => {
  const days = ['Saturday', 'Sunday'];
  const roles = ['Student', 'Teacher', 'Working professional', 'Other'];
  it('reads positions in English, Hindi and Marathi', () => {
    expect(matchOption('the second one', roles)).toBe('Teacher');
    expect(matchOption('option 3', roles)).toBe('Working professional');
    expect(matchOption('दूसरा', roles)).toBe('Teacher');
    expect(matchOption('दूसरा वाला', roles)).toBe('Teacher');
    expect(matchOption('पहिला', roles)).toBe('Student');
    expect(matchOption('B', roles)).toBe('Teacher');
    expect(matchOption('last one', roles)).toBe('Other');
    expect(matchOption('9', roles)).toBeNull();
  });
  it('reads numbers on scales as values, not positions', () => {
    expect(matchOption('three', ['1', '2', '3', '4', '5'])).toBe('3');
    expect(matchOption('तीन', ['1', '2', '3', '4', '5'])).toBe('3');
  });
  it('finds an option named in a sentence, unless negated', () => {
    expect(matchOption('I am a student', roles)).toBe('Student');
    expect(matchOption("I'm a working professional", roles)).toBe('Working professional');
    expect(matchOption('I am not a student', roles)).toBeNull();
    expect(matchOption('Sunday.', days)).toBe('Sunday');
  });
  it('maps common Hindi and Marathi words to English options', () => {
    expect(matchOption('महिला', ['Male', 'Female', 'Other'])).toBe('Female');
    expect(matchOption('पुरुष', ['Male', 'Female', 'Other'])).toBe('Male');
    expect(matchOption('मी विद्यार्थी आहे', roles)).toBe('Student');
  });
  it('tolerates small transcription slips but not guesses', () => {
    expect(matchOption('Saterday', days)).toBe('Saturday');
    expect(matchOption('Monday', days)).toBeNull();
    expect(matchOption('s', days)).toBeNull();
  });
  it('reads multi-select answers', () => {
    const checks = ['Eye check-up', 'Blood pressure, sugar', 'Dental'];
    expect(matchOptions('dental and eye check-up', checks)).toEqual(['Eye check-up', 'Dental']);
    expect(matchOptions('Eye check-up, Blood pressure, sugar', checks)).toEqual(['Eye check-up', 'Blood pressure, sugar']);
    expect(matchOptions('पहला और तीसरा', checks)).toEqual(['Eye check-up', 'Dental']);
    expect(matchOptions('all of them', checks)).toEqual(checks);
    expect(matchOptions('सगळे', checks)).toEqual(checks);
    expect(matchOptions('dental and haircut', checks)).toBeNull();
  });
  it('reads yes/no at the start of a sentence, in Marathi too', () => {
    expect(leadingYesNo('Yes, I do')).toBe('Yes');
    expect(leadingYesNo('हो')).toBe('Yes');
    expect(leadingYesNo('नाही')).toBe('No');
    expect(leadingYesNo('ji nahi')).toBe('No');
    expect(leadingYesNo('maybe')).toBeNull();
  });
});
