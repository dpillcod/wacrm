import { DEFAULT_BUSINESS_SETTINGS, mergeSettings, type BusinessSettings } from '../settings'

/**
 * A made-up store for tests: Ecuador time (UTC-5), open Mon–Sat
 * 7am–10pm and Sunday 8am–10pm, with a couple of cross-sell rules.
 * Tests use it instead of any real business's data.
 */
export const DEMO_STORE: BusinessSettings = mergeSettings(DEFAULT_BUSINESS_SETTINGS, {
  name: 'Tienda Demo',
  city: 'Cuenca',
  country: 'Ecuador',
  utcOffsetHours: -5,
  phoneCountryCode: '593',
  websiteUrl: 'https://tienda-demo.example',
  googleReviewUrl: 'https://g.page/r/demo/review',
  openingHours: [[8, 22], [7, 22], [7, 22], [7, 22], [7, 22], [7, 22], [7, 22]],
  staffPhones: ['0999999999'],
  crossSell: [
    { keyword: 'pan', suggestion: 'Por cierto, si desea le agrego queso fresco o café 🙂' },
    { keyword: 'panes', suggestion: 'Por cierto, si desea le agrego queso fresco o café 🙂' },
    { keyword: 'queso', suggestion: 'Por cierto, tenemos pan recién horneado, ¿le agrego? 🙂' },
    { keyword: 'arroz', suggestion: 'Por cierto, ¿le hace falta aceite para la comida? 🙂' },
  ],
})
