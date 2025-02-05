const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const readline = require('readline');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');

const { cities, searchUrl } = require('./config');
const CSV_FILE = 'establishments.csv';
const CSV_HEADERS = ['name', 'phone', 'address', 'city', 'scrapedAt'];

class ScraperManager {
  constructor() {
    this.isRunning = true;
    this.existingData = new Set();
    this.stats = {
      total: 0,
      new: 0,
      duplicates: 0,
      errors: 0
    };
    this.currentCity = '';
    this.browser = null;
    this.page = null;
  }

  showBanner() {
    console.log(`
╔════════════════════════════════════════════════════╗
║             SCRAPER GOOGLE MAPS v2.0               ║
╠════════════════════════════════════════════════════╣
║ Commandes disponibles:                             ║
║ q: Quitter     p: Pause    r: Reprendre            ║
║ s: Stats       c: Change ville                     ║
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
        case 'd':
          console.log('🔍 État actuel:', {
            ville: this.currentCity,
            ...this.stats,
            isRunning: this.isRunning
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
• Ville en cours: ${this.currentCity}
    `);
  }

  async initBrowser() {
    this.browser = await puppeteer.launch({
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
    this.page = await this.browser.newPage();
    
    
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
  }

  async loadExistingData() {
    try {
      const fileExists = await fs.access(CSV_FILE).then(() => true).catch(() => false);
      if (!fileExists) {
        await fs.writeFile(CSV_FILE, CSV_HEADERS.join(',') + '\n');
        return;
      }

      const fileContent = await fs.readFile(CSV_FILE, 'utf-8');
      const records = await new Promise((resolve) => {
        const results = [];
        parse(fileContent, { columns: true })
          .on('data', (data) => {
            this.existingData.add(`${data.name}-${data.address}`);
            results.push(data);
          })
          .on('end', () => resolve(results));
      });
      
      this.stats.total = records.length;
      console.log(`📂 ${records.length} établissements chargés du CSV`);
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

      const csvLine = await new Promise((resolve) => {
        stringify([newRow], { header: false }, (err, output) => resolve(output));
      });

      await fs.appendFile(CSV_FILE, csvLine);
      this.existingData.add(key);
      this.stats.new++;
      this.stats.total++;
      return true;
    } catch (error) {
      console.error('❌ Erreur sauvegarde:', error.message);
      this.stats.errors++;
      return false;
    }
  }

  async processEstablishment(element) {
    try {
      const data = await this.page.evaluate(async (el) => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 300));
        el.click();
        await new Promise(resolve => setTimeout(resolve, 500));

        const info = {
          name: document.querySelector('.DUwDvf')?.textContent?.trim() || '',
          phone: '',
          address: ''
        };

        document.querySelectorAll('.Io6YTe').forEach(el => {
          const text = el.textContent.trim();
          if (text.match(/^\+33|^0[1-9]/)) info.phone = text;
          else if (text.includes('France') || text.match(/\d{5}/)) info.address = text;
        });

        document.querySelector('button[jsaction="pane.back"]')?.click();
        return info;
      }, element);

      if (data.name && data.address && data.phone) {
        data.city = this.currentCity;
        await this.saveEstablishment(data);
        process.stdout.write(`\r✅ ${this.stats.new} établissements traités`);
      }
    } catch (error) {
      this.stats.errors++;
      process.stdout.write('\r❌ Erreur traitement établissement');
    }
  }

  async scrapeCity(city) {
    try {
      this.currentCity = city;
      console.log(`\n🏙️ Traitement de ${city}`);
  
      await this.page.goto(`${searchUrl}${encodeURIComponent(city)}`, {
        waitUntil: 'networkidle0',
        timeout: 90000
      });

      
      try {
        await this.page.waitForSelector('form:has(button[aria-label="Tout refuser"])', { timeout: 5000 });
        await this.page.click('button[aria-label="Tout refuser"]');
        await new Promise(r => setTimeout(r, 1000));
      } catch {}

      let lastCount = 0;
      let sameCountIterations = 0;

      while (this.isRunning && sameCountIterations < 3) {
        const elements = await this.page.$$('.hfpxzc');
        
        if (elements.length === lastCount) {
          sameCountIterations++;
        } else {
          sameCountIterations = 0;
          lastCount = elements.length;
        }

        for (const element of elements) {
          if (!this.isRunning) break;
          await this.processEstablishment(element);
        }

        await this.page.evaluate(() => {
          const resultsList = document.querySelector('.m6QErb');
          if (resultsList) resultsList.scrollTop = resultsList.scrollHeight;
        });

        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error(`\n❌ Erreur pour ${city}:`, error.message);
      this.stats.errors++;
    }
  }

  async start() {
    try {
      this.showBanner();
      await this.setupConsoleCommands();
      await this.loadExistingData();
      await this.initBrowser();

      for (const city of cities) {
        if (!this.isRunning) break;
        await this.scrapeCity(city);
      }      
    } catch (error) {
      console.error('❌ Erreur critique:', error.message);
    } finally {
      if (this.browser) await this.browser.close();
      this.showStats();
      console.log('\n✨ Scraping terminé');
      process.exit(0);
    }
  }
}

new ScraperManager().start();


