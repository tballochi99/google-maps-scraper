const puppeteer = require("puppeteer")
const fs = require("fs").promises
const readline = require("readline")

const fancyCredit = `
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   ████████╗██╗███╗   ███╗ ██████╗ ████████╗███████╗        ║
║   ╚══██╔══╝██║████╗ ████║██╔═══██╗╚══██╔══╝██╔════╝        ║
║      ██║   ██║██╔████╔██║██║   ██║   ██║   █████╗          ║
║      ██║   ██║██║╚██╔╝██║██║   ██║   ██║   ██╔══╝          ║
║      ██║   ██║██║ ╚═╝ ██║╚██████╔╝   ██║   ███████╗        ║
║      ╚═╝   ╚═╝╚═╝     ╚═╝ ╚═════╝    ╚═╝   ╚══════╝        ║
║                                                            ║
║                                                            ║
║        Gloire à Timoté Ballochi pour ce scrapping          ║
║                      de qualité !                          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`

console.log(fancyCredit)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

let isRunning = true

function setupStopHandler() {
  console.log('\n👉 Appuyez sur "q" puis Entrée pour arrêter le script à tout moment\n')

  rl.on("line", (input) => {
    if (input.toLowerCase() === "q") {
      console.log("\n🛑 Arrêt demandé. Finalisation du traitement en cours...")
      isRunning = false
    }
  })
}

async function delay(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time)
  })
}

async function loadExistingData() {
  try {
    const fileContent = await fs.readFile("establishments.json", "utf-8")
    const parsedContent = JSON.parse(fileContent)
    return parsedContent.data || []
  } catch (error) {
    return []
  }
}

async function saveEstablishment(establishment, existingData) {
  const isDuplicate = existingData.some(
    (existing) => existing.name === establishment.name && existing.address === establishment.address,
  )

  if (!isDuplicate && establishment.name !== "Résultats") {
    existingData.push(establishment)

    await fs.writeFile(
      "establishments.json",
      JSON.stringify(
        {
          credit: "Gloire à Timoté",
          data: existingData,
        },
        null,
        2,
      ),
      "utf-8",
    )
    return true
  }
  return false
}

async function scrapeGoogleMaps() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"],
  })

  const existingData = await loadExistingData()
  console.log(`📊 ${existingData.length} établissements déjà enregistrés\n`)

  setupStopHandler()

  try {
    const page = await browser.newPage()
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    )

    // Liste des grandes villes françaises à parcourir
    const cities = [
      "Paris",
      "Marseille",
      "Lyon",
      "Toulouse",
      "Nice",
      "Nantes",
      "Strasbourg",
      "Montpellier",
      "Bordeaux",
      "Lille",
      "Rennes",
      "Reims",
      "Le Havre",
      "Saint-Étienne",
      "Toulon",
      "Grenoble",
      "Dijon",
      "Angers",
      "Nîmes",
      "Villeurbanne",
    ]

    for (const city of cities) {
      if (!isRunning) break

      console.log(`🏙️ Recherche dans : ${city}`)
      await page.goto(`https://www.google.fr/maps/search/salle+de+jeu+et+de+divertissement+${city}`, {
        waitUntil: "networkidle0",
      })

      try {
        await page.waitForSelector('form:has(button[aria-label="Tout refuser"])', { timeout: 5000 })
        const refuseButton = await page.$('button[aria-label="Tout refuser"]')
        if (refuseButton) {
          await refuseButton.click()
          await delay(2000)
        }
      } catch {
        console.log("ℹ️ Pas de formulaire de consentement ou déjà accepté\n")
      }

      console.log("🔄 Chargement des résultats...\n")
      await page.waitForSelector(".hfpxzc", { timeout: 15000 })

      const processedEstablishments = new Set()
      let noNewEstablishmentsCount = 0
      let scrollCount = 0

      while (isRunning && noNewEstablishmentsCount < 3 && scrollCount < 10) {
        try {
          const newEstablishments = await page.evaluate(async () => {
            const establishments = []
            const elements = document.querySelectorAll(".hfpxzc")

            for (const element of elements) {
              element.scrollIntoView({ behavior: "smooth", block: "center" })
              await new Promise((resolve) => setTimeout(resolve, 500))

              element.click()
              await new Promise((resolve) => setTimeout(resolve, 1000))

              const title = document.querySelector(".DUwDvf")?.textContent?.trim() || ""
              const infoElements = Array.from(document.getElementsByClassName("Io6YTe"))

              let phone = ""
              let address = ""

              infoElements.forEach((element) => {
                const text = element.textContent.trim()
                if (text.match(/^\+33|^0[1-9]/)) phone = text
                else if (text.includes("France") || text.match(/\d{5}/)) address = text
              })

              if (title && title !== "Résultats" && address && phone) {
                establishments.push({ name: title, phone, address })
              }

              const backButton = document.querySelector('button[jsaction="pane.back"]')
              if (backButton) backButton.click()
              await new Promise((resolve) => setTimeout(resolve, 500))
            }

            return establishments
          })

          let foundNewEstablishment = false

          for (const establishmentInfo of newEstablishments) {
            const establishmentKey = `${establishmentInfo.name}-${establishmentInfo.address}`
            if (!processedEstablishments.has(establishmentKey)) {
              process.stdout.write("\x1b[2J\x1b[0f") // Nettoie la console
              console.log("🔄 Scraping en cours... (q + Entrée pour arrêter)\n")
              console.log("📍 Établissement en cours :", establishmentInfo)

              const saved = await saveEstablishment(establishmentInfo, existingData)
              if (saved) {
                console.log("✅ Enregistré ! Total :", existingData.length, "établissements\n")
                processedEstablishments.add(establishmentKey)
                foundNewEstablishment = true
              } else {
                console.log("⚠️ Doublon détecté ou nom invalide - non enregistré\n")
              }
            }
          }

          if (!foundNewEstablishment) {
            noNewEstablishmentsCount++
          } else {
            noNewEstablishmentsCount = 0
          }

          if (!isRunning) break

          // Faire défiler pour charger plus de résultats
          await page.evaluate(() => {
            const resultsList = document.querySelector(".m6QErb")
            if (resultsList) {
              resultsList.scrollTop = resultsList.scrollHeight
            }
          })

          await delay(2000)
          scrollCount++
        } catch (error) {
          console.error("Erreur lors du scraping :", error)
          if (!isRunning) break
          await delay(1000)
        }
      }

      console.log(`Fin du scraping pour ${city}. Passage à la ville suivante.\n`)
    }

    console.log("\n✨ Scraping terminé !")
    console.log(`📊 Total final : ${existingData.length} établissements dans le fichier\n`)
  } catch (error) {
    console.error("❌ Erreur principale:", error)
  } finally {
    await browser.close()
    rl.close()
  }
}

scrapeGoogleMaps()

console.log('Script lancé et gloire à . Appuyez sur "q" puis Entrée pour arrêter à tout moment.')