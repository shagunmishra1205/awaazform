import type { Metadata, Viewport } from 'next';
import {
  Fira_Code, Inter, Noto_Nastaliq_Urdu, Noto_Sans_Bengali, Noto_Sans_Devanagari, Noto_Sans_Gujarati, Noto_Sans_Gurmukhi,
  Noto_Sans_Kannada, Noto_Sans_Malayalam, Noto_Sans_Tamil, Noto_Sans_Telugu,
} from 'next/font/google';
import { Nav } from '@/components/Nav';
import { PwaProvider } from '@/components/PwaProvider';
import { SettingsProvider, settingsBootScript } from '@/lib/settings';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const devanagari = Noto_Sans_Devanagari({ subsets: ['devanagari'], variable: '--font-devanagari', display: 'swap' });
const fira = Fira_Code({ subsets: ['latin'], variable: '--font-fira', display: 'swap' });
// One Noto family per script. Not preloaded: the browser fetches a font only when its script appears.
const bengali = Noto_Sans_Bengali({ subsets: ['bengali'], variable: '--font-bengali', display: 'swap', preload: false });
const gujarati = Noto_Sans_Gujarati({ subsets: ['gujarati'], variable: '--font-gujarati', display: 'swap', preload: false });
const gurmukhi = Noto_Sans_Gurmukhi({ subsets: ['gurmukhi'], variable: '--font-gurmukhi', display: 'swap', preload: false });
const tamil = Noto_Sans_Tamil({ subsets: ['tamil'], variable: '--font-tamil', display: 'swap', preload: false });
const telugu = Noto_Sans_Telugu({ subsets: ['telugu'], variable: '--font-telugu', display: 'swap', preload: false });
const kannada = Noto_Sans_Kannada({ subsets: ['kannada'], variable: '--font-kannada', display: 'swap', preload: false });
const malayalam = Noto_Sans_Malayalam({ subsets: ['malayalam'], variable: '--font-malayalam', display: 'swap', preload: false });
const urdu = Noto_Nastaliq_Urdu({ subsets: ['arabic'], variable: '--font-urdu', display: 'swap', preload: false });
const fonts = [inter, devanagari, fira, bengali, gujarati, gurmukhi, tamil, telugu, kannada, malayalam, urdu].map((f) => f.variable).join(' ');

export const metadata: Metadata = {
  applicationName: 'AwaazForm',
  appleWebApp: { capable: true, title: 'AwaazForm', statusBarStyle: 'default' },
  icons: { apple: '/icons/apple-touch-icon.png' },
  formatDetection: { telephone: false },
  title: 'AwaazForm — Your voice. Your form. Your access.',
  description: 'Fill Google Forms, Microsoft Forms, PDFs and Word files by voice in English and 12 Indian languages. Every answer is read back and filled only after you confirm.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#624de3' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fonts} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: settingsBootScript }} />
      </head>
      <body>
        <SettingsProvider>
          <PwaProvider>
          <Nav />
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
          </PwaProvider>
        </SettingsProvider>
      </body>
    </html>
  );
}
