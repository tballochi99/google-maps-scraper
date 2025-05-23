const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs').promises;
const readline = require('readline');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify/sync');
const { cities, searchUrl } = require('./config');

const CSV_FILE = 'establishments.csv';
const CSV_HEADERS = ['name', 'phone', 'address', 'city', 'scrapedAt'];
const MAX_DUPLICATES = 50;
const MAX_RETRIES = 3;
const CONCURRENT_CITIES = 3;

class ScraperManager {
  constructor() {
    this.isRunning = true;
    this.existingData = new Map();
    this.stats = {
      total: 0,
      new: 0,
      duplicates: 0,
      errors: 0,
      retries: 0
    };
    this.cityQueue = [...cities];
    this.activeBrowsers = [];
  }

  showBanner() {
    console.log(`
╔════════════════════════════════════════════════════╗
║             SCRAPER GOOGLE MAPS v3.0               ║
╠════════════════════════════════════════════════════╣
║ Commandes disponibles:                             ║
║ q: Quitter     p: Pause    r: Reprendre            ║
║ s: Stats       n: Ville suivante                   ║
║ d: Debug mode  h: Aide                             ║
╚════════════════════════════════════════════════════╝
    `);
  }

  async setupConsoleCommands() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on('line', async (input) => {
      switch(input.toLowerCase()) {
        case 'q':
          console.log('\n🛑 Arrêt en cours...');
          this.isRunning = false;
          await this.closeAllBrowsers();
          break;
        case 'p':
          this.isRunning = false;
          console.log('⏸️ Pause');
          break;
        case 'r':
          this.isRunning = true;
          console.log('▶️ Reprise');
          break;
        case 's':
          this.showStats();
          break;
        case 'n':
          console.log('⏭️ Passage à la ville suivante');
          this.moveToNextCity();
          break;
        case 'd':
          console.log('🔍 État actuel:', {
            villesRestantes: this.cityQueue.length,
            ...this.stats,
            isRunning: this.isRunning,
          });
          break;
        case 'h':
          this.showBanner();
          break;
      }
    });
  }

  showStats() {
    console.log(`
📊 Statistiques:
• Total établissements: ${this.stats.total}
• Nouveaux ajoutés: ${this.stats.new}
• Doublons évités: ${this.stats.duplicates}
• Erreurs: ${this.stats.errors}
• Tentatives de récupération: ${this.stats.retries}
• Villes restantes: ${this.cityQueue.length}
    `);
  }

  async initBrowser() {
    const browser = await puppeteer.launch({
      headless: 'new',
      defaultViewport: { width: 1920, height: 1080 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
    return { browser, page };
  }

  async loadExistingData() {
    try {
      const fileExists = await fs.access(CSV_FILE).then(() => true).catch(() => false);
      if (!fileExists) {
        await fs.writeFile(CSV_FILE, CSV_HEADERS.join(',') + '\n');
        return;
      }

      const fileContent = await fs.readFile(CSV_FILE, 'utf-8');
      await new Promise((resolve) => {
        parse(fileContent, { columns: true })
          .on('data', (data) => {
            const key = `${data.name}-${data.address}`;
            this.existingData.set(key, data);
          })
          .on('end', resolve);
      });

      this.stats.total = this.existingData.size;
      console.log(`📂 ${this.stats.total} établissements chargés du CSV`);
    } catch (error) {
      console.error('❌ Erreur chargement données:', error.message);
    }
  }

  async saveEstablishment(establishment) {
    const key = `${establishment.name}-${establishment.address}`;
    if (this.existingData.has(key)) {
      this.stats.duplicates++;
      return false;
    }

    try {
      const newRow = {
        ...establishment,
        scrapedAt: new Date().toISOString()
      };

      const csvLine = stringify([newRow], { header: false });
      await fs.appendFile(CSV_FILE, csvLine);
      this.existingData.set(key, newRow);
      this.stats.new++;
      this.stats.total++;
      return true;
    } catch (error) {
      console.error('❌ Erreur sauvegarde:', error.message);
      this.stats.errors++;
      return false;
    }
  }

  async processEstablishment(page, element, city) {
    try {
      const data = await page.evaluate(async (el) => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 300));
        el.click();
        await new Promise(resolve => setTimeout(resolve, 500));

        const info = {
          name: document.querySelector('.DUwDvf')?.textContent?.trim() || '',
          phone: '',
          address: '',
          website: ''
        };

        document.querySelectorAll('.Io6YTe').forEach(el => {
          const text = el.textContent.trim();
          if (text.match(/^\+33|^0[1-9]/)) info.phone = text;
          else if (text.includes('France') || text.match(/\d{5}/)) info.address = text;
        });

        info.website = document.querySelector('a[data-item-id="authority"]')?.href || '';

        document.querySelector('button[jsaction="pane.back"]')?.click();
        return info;
      }, element).catch(e => {
        console.error('Erreur lors de l\'évaluation de l\'élément:', e.message);
        return null;
      });

      if (data && data.name && data.address) {
        data.city = city;
        await this.saveEstablishment(data);
        process.stdout.write(`\r✅ ${this.stats.new} établissements traités`);
      }
    } catch (error) {
      this.stats.errors++;
      process.stdout.write('\r❌ Erreur traitement établissement');
    }
  }

  moveToNextCity() {
    this.cityQueue.shift();
    this.stats.duplicates = 0;
  }

  async scrapeCity(city, retryCount = 0) {
    const { browser, page } = await this.initBrowser();
    this.activeBrowsers.push({ browser, page });

    try {
      console.log(`\n🏙️ Traitement de ${city} (Tentative ${retryCount + 1}/${MAX_RETRIES})`);

      await page.goto(`${searchUrl}${encodeURIComponent(city)}`, {
        waitUntil: 'networkidle0',
        timeout: 90000
      });

      // Handle cookie consent
      try {
        await page.waitForSelector('form:has(button[aria-label="Tout refuser"])', { timeout: 5000 });
        await page.click('button[aria-label="Tout refuser"]');
        await new Promise(r => setTimeout(r, 1000));
      } catch (cookieError) {
        console.log('Pas de bannière de cookies ou erreur lors de la gestion des cookies');
      }

      let lastCount = 0;
      let sameCountIterations = 0;

      while (this.isRunning && sameCountIterations < 3 && this.stats.duplicates < MAX_DUPLICATES) {
        try {
          const elements = await page.$$('.hfpxzc');

          if (elements.length === lastCount) {
            sameCountIterations++;
          } else {
            sameCountIterations = 0;
            lastCount = elements.length;
          }

          for (const element of elements) {
            if (!this.isRunning || this.stats.duplicates >= MAX_DUPLICATES) break;
            await this.processEstablishment(page, element, city);
          }

          await page.evaluate(() => {
            const resultsList = document.querySelector('.m6QErb');
            if (resultsList) resultsList.scrollTop = resultsList.scrollHeight;
          });

          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        } catch (scrollError) {
          console.error(`Erreur lors du défilement: ${scrollError.message}`);
          break;
        }
      }

      if (this.stats.duplicates >= MAX_DUPLICATES) {
        console.log(`\n🔄 ${MAX_DUPLICATES} doublons atteints pour ${city}`);
      }
    } catch (error) {
      console.error(`\n❌ Erreur pour ${city}:`, error.message);
      this.stats.errors++;

      if (retryCount < MAX_RETRIES - 1) {
        console.log(`Tentative de récupération... (${retryCount + 1}/${MAX_RETRIES})`);
        this.stats.retries++;
        await this.scrapeCity(city, retryCount + 1);
      } else {
        console.log(`Échec après ${MAX_RETRIES} tentatives pour ${city}.`);
      }
    } finally {
      await browser.close();
      this.activeBrowsers = this.activeBrowsers.filter(b => b.browser !== browser);
      this.moveToNextCity();
    }
  }

  async start() {
    try {
      this.showBanner();
      await this.setupConsoleCommands();
      await this.loadExistingData();

      while (this.cityQueue.length > 0 && this.isRunning) {
        const nextCities = this.cityQueue.slice(0, CONCURRENT_CITIES);
        await Promise.all(nextCities.map(city => this.scrapeCity(city)));
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
      }
    } catch (error) {
      console.error('❌ Erreur critique:', error.message);
    } finally {
      await this.closeAllBrowsers();
      this.showStats();
      console.log('\n✨ Scraping terminé');
      process.exit(0);
    }
  }

  async closeAllBrowsers() {
    for (const { browser } of this.activeBrowsers) {
      await browser.close();
    }
    this.activeBrowsers = [];
  }
}

new ScraperManager().start();
