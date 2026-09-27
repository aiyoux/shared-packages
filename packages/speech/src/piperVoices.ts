import { SpeechEngineError, type SpeechModelDef, type TtsVoice } from './types.js';

/**
 * Vendored Piper voice catalog (snapshot of @mintplex-labs/piper-tts-web's
 * inline PATH_MAP, 123 voices / 37 languages). The library's own voices()
 * fetches a JSON from huggingface.co, which the hub's COOP+COEP isolation
 * blocks — so the catalog lives here and voice files are user-imported like
 * every other speech model.
 */

export const PIPER_HF_REPO = 'diffusionstudio/piper-voices';
export const PIPER_HF_REVISION = 'main';

export type PiperVoice = {
	id: string;
	label: string;
	/** e.g. en_US — also the sort/group key. */
	language: string;
	/** Repo path of the .onnx file, e.g. en/en_US/amy/medium/en_US-amy-medium.onnx. */
	path: string;
};

const VOICES: readonly PiperVoice[] = [
	{ id: 'ar_JO-kareem-low', label: 'Kareem · Arabic (Jordan) · low', language: 'ar_JO', path: 'ar/ar_JO/kareem/low/ar_JO-kareem-low.onnx' },
	{ id: 'ar_JO-kareem-medium', label: 'Kareem · Arabic (Jordan) · medium', language: 'ar_JO', path: 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx' },
	{ id: 'ca_ES-upc_ona-medium', label: 'Upc_ona · Catalan · medium', language: 'ca_ES', path: 'ca/ca_ES/upc_ona/medium/ca_ES-upc_ona-medium.onnx' },
	{ id: 'ca_ES-upc_ona-x_low', label: 'Upc_ona · Catalan · extra-low', language: 'ca_ES', path: 'ca/ca_ES/upc_ona/x_low/ca_ES-upc_ona-x_low.onnx' },
	{ id: 'ca_ES-upc_pau-x_low', label: 'Upc_pau · Catalan · extra-low', language: 'ca_ES', path: 'ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx' },
	{ id: 'cs_CZ-jirka-low', label: 'Jirka · Czech · low', language: 'cs_CZ', path: 'cs/cs_CZ/jirka/low/cs_CZ-jirka-low.onnx' },
	{ id: 'cs_CZ-jirka-medium', label: 'Jirka · Czech · medium', language: 'cs_CZ', path: 'cs/cs_CZ/jirka/medium/cs_CZ-jirka-medium.onnx' },
	{ id: 'cy_GB-gwryw_gogleddol-medium', label: 'Gwryw_gogleddol · Welsh · medium', language: 'cy_GB', path: 'cy/cy_GB/gwryw_gogleddol/medium/cy_GB-gwryw_gogleddol-medium.onnx' },
	{ id: 'da_DK-talesyntese-medium', label: 'Talesyntese · Danish · medium', language: 'da_DK', path: 'da/da_DK/talesyntese/medium/da_DK-talesyntese-medium.onnx' },
	{ id: 'de_DE-eva_k-x_low', label: 'Eva_k · German · extra-low', language: 'de_DE', path: 'de/de_DE/eva_k/x_low/de_DE-eva_k-x_low.onnx' },
	{ id: 'de_DE-karlsson-low', label: 'Karlsson · German · low', language: 'de_DE', path: 'de/de_DE/karlsson/low/de_DE-karlsson-low.onnx' },
	{ id: 'de_DE-kerstin-low', label: 'Kerstin · German · low', language: 'de_DE', path: 'de/de_DE/kerstin/low/de_DE-kerstin-low.onnx' },
	{ id: 'de_DE-mls-medium', label: 'Mls · German · medium', language: 'de_DE', path: 'de/de_DE/mls/medium/de_DE-mls-medium.onnx' },
	{ id: 'de_DE-pavoque-low', label: 'Pavoque · German · low', language: 'de_DE', path: 'de/de_DE/pavoque/low/de_DE-pavoque-low.onnx' },
	{ id: 'de_DE-ramona-low', label: 'Ramona · German · low', language: 'de_DE', path: 'de/de_DE/ramona/low/de_DE-ramona-low.onnx' },
	{ id: 'de_DE-thorsten-high', label: 'Thorsten · German · high', language: 'de_DE', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high.onnx' },
	{ id: 'de_DE-thorsten-low', label: 'Thorsten · German · low', language: 'de_DE', path: 'de/de_DE/thorsten/low/de_DE-thorsten-low.onnx' },
	{ id: 'de_DE-thorsten-medium', label: 'Thorsten · German · medium', language: 'de_DE', path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx' },
	{ id: 'de_DE-thorsten_emotional-medium', label: 'Thorsten_emotional · German · medium', language: 'de_DE', path: 'de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx' },
	{ id: 'el_GR-rapunzelina-low', label: 'Rapunzelina · Greek · low', language: 'el_GR', path: 'el/el_GR/rapunzelina/low/el_GR-rapunzelina-low.onnx' },
	{ id: 'en_GB-alan-low', label: 'Alan · English (UK) · low', language: 'en_GB', path: 'en/en_GB/alan/low/en_GB-alan-low.onnx' },
	{ id: 'en_GB-alan-medium', label: 'Alan · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx' },
	{ id: 'en_GB-alba-medium', label: 'Alba · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/alba/medium/en_GB-alba-medium.onnx' },
	{ id: 'en_GB-aru-medium', label: 'Aru · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/aru/medium/en_GB-aru-medium.onnx' },
	{ id: 'en_GB-cori-high', label: 'Cori · English (UK) · high', language: 'en_GB', path: 'en/en_GB/cori/high/en_GB-cori-high.onnx' },
	{ id: 'en_GB-cori-medium', label: 'Cori · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/cori/medium/en_GB-cori-medium.onnx' },
	{ id: 'en_GB-jenny_dioco-medium', label: 'Jenny_dioco · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx' },
	{ id: 'en_GB-northern_english_male-medium', label: 'Northern_english_male · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx' },
	{ id: 'en_GB-semaine-medium', label: 'Semaine · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/semaine/medium/en_GB-semaine-medium.onnx' },
	{ id: 'en_GB-southern_english_female-low', label: 'Southern_english_female · English (UK) · low', language: 'en_GB', path: 'en/en_GB/southern_english_female/low/en_GB-southern_english_female-low.onnx' },
	{ id: 'en_GB-vctk-medium', label: 'Vctk · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/vctk/medium/en_GB-vctk-medium.onnx' },
	{ id: 'en_US-amy-low', label: 'Amy · English (US) · low', language: 'en_US', path: 'en/en_US/amy/low/en_US-amy-low.onnx' },
	{ id: 'en_US-amy-medium', label: 'Amy · English (US) · medium', language: 'en_US', path: 'en/en_US/amy/medium/en_US-amy-medium.onnx' },
	{ id: 'en_US-arctic-medium', label: 'Arctic · English (US) · medium', language: 'en_US', path: 'en/en_US/arctic/medium/en_US-arctic-medium.onnx' },
	{ id: 'en_US-bryce-medium', label: 'Bryce · English (US) · medium', language: 'en_US', path: 'en/en_US/bryce/medium/en_US-bryce-medium.onnx' },
	{ id: 'en_US-danny-low', label: 'Danny · English (US) · low', language: 'en_US', path: 'en/en_US/danny/low/en_US-danny-low.onnx' },
	{ id: 'en_US-hfc_female-medium', label: 'Hfc_female · English (US) · medium', language: 'en_US', path: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx' },
	{ id: 'en_US-hfc_male-medium', label: 'Hfc_male · English (US) · medium', language: 'en_US', path: 'en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx' },
	{ id: 'en_US-joe-medium', label: 'Joe · English (US) · medium', language: 'en_US', path: 'en/en_US/joe/medium/en_US-joe-medium.onnx' },
	{ id: 'en_US-john-medium', label: 'John · English (US) · medium', language: 'en_US', path: 'en/en_US/john/medium/en_US-john-medium.onnx' },
	{ id: 'en_US-kathleen-low', label: 'Kathleen · English (US) · low', language: 'en_US', path: 'en/en_US/kathleen/low/en_US-kathleen-low.onnx' },
	{ id: 'en_US-kristin-medium', label: 'Kristin · English (US) · medium', language: 'en_US', path: 'en/en_US/kristin/medium/en_US-kristin-medium.onnx' },
	{ id: 'en_US-kusal-medium', label: 'Kusal · English (US) · medium', language: 'en_US', path: 'en/en_US/kusal/medium/en_US-kusal-medium.onnx' },
	{ id: 'en_US-l2arctic-medium', label: 'L2arctic · English (US) · medium', language: 'en_US', path: 'en/en_US/l2arctic/medium/en_US-l2arctic-medium.onnx' },
	{ id: 'en_US-lessac-high', label: 'Lessac · English (US) · high', language: 'en_US', path: 'en/en_US/lessac/high/en_US-lessac-high.onnx' },
	{ id: 'en_US-lessac-low', label: 'Lessac · English (US) · low', language: 'en_US', path: 'en/en_US/lessac/low/en_US-lessac-low.onnx' },
	{ id: 'en_US-lessac-medium', label: 'Lessac · English (US) · medium', language: 'en_US', path: 'en/en_US/lessac/medium/en_US-lessac-medium.onnx' },
	{ id: 'en_US-libritts-high', label: 'Libritts · English (US) · high', language: 'en_US', path: 'en/en_US/libritts/high/en_US-libritts-high.onnx' },
	{ id: 'en_US-libritts_r-medium', label: 'Libritts_r · English (US) · medium', language: 'en_US', path: 'en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx' },
	{ id: 'en_US-ljspeech-high', label: 'Ljspeech · English (US) · high', language: 'en_US', path: 'en/en_US/ljspeech/high/en_US-ljspeech-high.onnx' },
	{ id: 'en_US-ljspeech-medium', label: 'Ljspeech · English (US) · medium', language: 'en_US', path: 'en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx' },
	{ id: 'en_US-norman-medium', label: 'Norman · English (US) · medium', language: 'en_US', path: 'en/en_US/norman/medium/en_US-norman-medium.onnx' },
	{ id: 'en_US-ryan-high', label: 'Ryan · English (US) · high', language: 'en_US', path: 'en/en_US/ryan/high/en_US-ryan-high.onnx' },
	{ id: 'en_US-ryan-low', label: 'Ryan · English (US) · low', language: 'en_US', path: 'en/en_US/ryan/low/en_US-ryan-low.onnx' },
	{ id: 'en_US-ryan-medium', label: 'Ryan · English (US) · medium', language: 'en_US', path: 'en/en_US/ryan/medium/en_US-ryan-medium.onnx' },
	{ id: 'es_ES-carlfm-x_low', label: 'Carlfm · Spanish (Spain) · extra-low', language: 'es_ES', path: 'es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx' },
	{ id: 'es_ES-davefx-medium', label: 'Davefx · Spanish (Spain) · medium', language: 'es_ES', path: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx' },
	{ id: 'es_ES-mls_10246-low', label: 'Mls_10246 · Spanish (Spain) · low', language: 'es_ES', path: 'es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx' },
	{ id: 'es_ES-mls_9972-low', label: 'Mls_9972 · Spanish (Spain) · low', language: 'es_ES', path: 'es/es_ES/mls_9972/low/es_ES-mls_9972-low.onnx' },
	{ id: 'es_ES-sharvard-medium', label: 'Sharvard · Spanish (Spain) · medium', language: 'es_ES', path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx' },
	{ id: 'es_MX-ald-medium', label: 'Ald · Spanish (Mexico) · medium', language: 'es_MX', path: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx' },
	{ id: 'es_MX-claude-high', label: 'Claude · Spanish (Mexico) · high', language: 'es_MX', path: 'es/es_MX/claude/high/es_MX-claude-high.onnx' },
	{ id: 'fa_IR-amir-medium', label: 'Amir · Persian · medium', language: 'fa_IR', path: 'fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx' },
	{ id: 'fa_IR-gyro-medium', label: 'Gyro · Persian · medium', language: 'fa_IR', path: 'fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx' },
	{ id: 'fi_FI-harri-low', label: 'Harri · Finnish · low', language: 'fi_FI', path: 'fi/fi_FI/harri/low/fi_FI-harri-low.onnx' },
	{ id: 'fi_FI-harri-medium', label: 'Harri · Finnish · medium', language: 'fi_FI', path: 'fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx' },
	{ id: 'fr_FR-gilles-low', label: 'Gilles · French · low', language: 'fr_FR', path: 'fr/fr_FR/gilles/low/fr_FR-gilles-low.onnx' },
	{ id: 'fr_FR-mls-medium', label: 'Mls · French · medium', language: 'fr_FR', path: 'fr/fr_FR/mls/medium/fr_FR-mls-medium.onnx' },
	{ id: 'fr_FR-mls_1840-low', label: 'Mls_1840 · French · low', language: 'fr_FR', path: 'fr/fr_FR/mls_1840/low/fr_FR-mls_1840-low.onnx' },
	{ id: 'fr_FR-siwis-low', label: 'Siwis · French · low', language: 'fr_FR', path: 'fr/fr_FR/siwis/low/fr_FR-siwis-low.onnx' },
	{ id: 'fr_FR-siwis-medium', label: 'Siwis · French · medium', language: 'fr_FR', path: 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx' },
	{ id: 'fr_FR-tom-medium', label: 'Tom · French · medium', language: 'fr_FR', path: 'fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx' },
	{ id: 'fr_FR-upmc-medium', label: 'Upmc · French · medium', language: 'fr_FR', path: 'fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx' },
	{ id: 'hu_HU-anna-medium', label: 'Anna · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/anna/medium/hu_HU-anna-medium.onnx' },
	{ id: 'hu_HU-berta-medium', label: 'Berta · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/berta/medium/hu_HU-berta-medium.onnx' },
	{ id: 'hu_HU-imre-medium', label: 'Imre · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/imre/medium/hu_HU-imre-medium.onnx' },
	{ id: 'is_IS-bui-medium', label: 'Bui · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/bui/medium/is_IS-bui-medium.onnx' },
	{ id: 'is_IS-salka-medium', label: 'Salka · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/salka/medium/is_IS-salka-medium.onnx' },
	{ id: 'is_IS-steinn-medium', label: 'Steinn · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/steinn/medium/is_IS-steinn-medium.onnx' },
	{ id: 'is_IS-ugla-medium', label: 'Ugla · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/ugla/medium/is_IS-ugla-medium.onnx' },
	{ id: 'it_IT-paola-medium', label: 'Paola · Italian · medium', language: 'it_IT', path: 'it/it_IT/paola/medium/it_IT-paola-medium.onnx' },
	{ id: 'it_IT-riccardo-x_low', label: 'Riccardo · Italian · extra-low', language: 'it_IT', path: 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx' },
	{ id: 'ka_GE-natia-medium', label: 'Natia · Georgian · medium', language: 'ka_GE', path: 'ka/ka_GE/natia/medium/ka_GE-natia-medium.onnx' },
	{ id: 'kk_KZ-iseke-x_low', label: 'Iseke · Kazakh · extra-low', language: 'kk_KZ', path: 'kk/kk_KZ/iseke/x_low/kk_KZ-iseke-x_low.onnx' },
	{ id: 'kk_KZ-issai-high', label: 'Issai · Kazakh · high', language: 'kk_KZ', path: 'kk/kk_KZ/issai/high/kk_KZ-issai-high.onnx' },
	{ id: 'kk_KZ-raya-x_low', label: 'Raya · Kazakh · extra-low', language: 'kk_KZ', path: 'kk/kk_KZ/raya/x_low/kk_KZ-raya-x_low.onnx' },
	{ id: 'lb_LU-marylux-medium', label: 'Marylux · Luxembourgish · medium', language: 'lb_LU', path: 'lb/lb_LU/marylux/medium/lb_LU-marylux-medium.onnx' },
	{ id: 'ne_NP-google-medium', label: 'Google · Nepali · medium', language: 'ne_NP', path: 'ne/ne_NP/google/medium/ne_NP-google-medium.onnx' },
	{ id: 'ne_NP-google-x_low', label: 'Google · Nepali · extra-low', language: 'ne_NP', path: 'ne/ne_NP/google/x_low/ne_NP-google-x_low.onnx' },
	{ id: 'nl_BE-nathalie-medium', label: 'Nathalie · Dutch (Flemish) · medium', language: 'nl_BE', path: 'nl/nl_BE/nathalie/medium/nl_BE-nathalie-medium.onnx' },
	{ id: 'nl_BE-nathalie-x_low', label: 'Nathalie · Dutch (Flemish) · extra-low', language: 'nl_BE', path: 'nl/nl_BE/nathalie/x_low/nl_BE-nathalie-x_low.onnx' },
	{ id: 'nl_BE-rdh-medium', label: 'Rdh · Dutch (Flemish) · medium', language: 'nl_BE', path: 'nl/nl_BE/rdh/medium/nl_BE-rdh-medium.onnx' },
	{ id: 'nl_BE-rdh-x_low', label: 'Rdh · Dutch (Flemish) · extra-low', language: 'nl_BE', path: 'nl/nl_BE/rdh/x_low/nl_BE-rdh-x_low.onnx' },
	{ id: 'nl_NL-mls-medium', label: 'Mls · Dutch · medium', language: 'nl_NL', path: 'nl/nl_NL/mls/medium/nl_NL-mls-medium.onnx' },
	{ id: 'nl_NL-mls_5809-low', label: 'Mls_5809 · Dutch · low', language: 'nl_NL', path: 'nl/nl_NL/mls_5809/low/nl_NL-mls_5809-low.onnx' },
	{ id: 'nl_NL-mls_7432-low', label: 'Mls_7432 · Dutch · low', language: 'nl_NL', path: 'nl/nl_NL/mls_7432/low/nl_NL-mls_7432-low.onnx' },
	{ id: 'no_NO-talesyntese-medium', label: 'Talesyntese · Norwegian · medium', language: 'no_NO', path: 'no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx' },
	{ id: 'pl_PL-darkman-medium', label: 'Darkman · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx' },
	{ id: 'pl_PL-gosia-medium', label: 'Gosia · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx' },
	{ id: 'pl_PL-mc_speech-medium', label: 'Mc_speech · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/mc_speech/medium/pl_PL-mc_speech-medium.onnx' },
	{ id: 'pl_PL-mls_6892-low', label: 'Mls_6892 · Polish · low', language: 'pl_PL', path: 'pl/pl_PL/mls_6892/low/pl_PL-mls_6892-low.onnx' },
	{ id: 'pt_BR-edresson-low', label: 'Edresson · Portuguese (Brazil) · low', language: 'pt_BR', path: 'pt/pt_BR/edresson/low/pt_BR-edresson-low.onnx' },
	{ id: 'pt_BR-faber-medium', label: 'Faber · Portuguese (Brazil) · medium', language: 'pt_BR', path: 'pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx' },
	{ id: 'pt_PT-tugão-medium', label: 'Tugão · Portuguese (Portugal) · medium', language: 'pt_PT', path: 'pt/pt_PT/tugão/medium/pt_PT-tugão-medium.onnx' },
	{ id: 'ro_RO-mihai-medium', label: 'Mihai · Romanian · medium', language: 'ro_RO', path: 'ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx' },
	{ id: 'ru_RU-denis-medium', label: 'Denis · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx' },
	{ id: 'ru_RU-dmitri-medium', label: 'Dmitri · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx' },
	{ id: 'ru_RU-irina-medium', label: 'Irina · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx' },
	{ id: 'ru_RU-ruslan-medium', label: 'Ruslan · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx' },
	{ id: 'sk_SK-lili-medium', label: 'Lili · Slovak · medium', language: 'sk_SK', path: 'sk/sk_SK/lili/medium/sk_SK-lili-medium.onnx' },
	{ id: 'sl_SI-artur-medium', label: 'Artur · Slovenian · medium', language: 'sl_SI', path: 'sl/sl_SI/artur/medium/sl_SI-artur-medium.onnx' },
	{ id: 'sr_RS-serbski_institut-medium', label: 'Serbski_institut · Serbian · medium', language: 'sr_RS', path: 'sr/sr_RS/serbski_institut/medium/sr_RS-serbski_institut-medium.onnx' },
	{ id: 'sv_SE-nst-medium', label: 'Nst · Swedish · medium', language: 'sv_SE', path: 'sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx' },
	{ id: 'sw_CD-lanfrica-medium', label: 'Lanfrica · Swahili · medium', language: 'sw_CD', path: 'sw/sw_CD/lanfrica/medium/sw_CD-lanfrica-medium.onnx' },
	{ id: 'tr_TR-dfki-medium', label: 'Dfki · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx' },
	{ id: 'tr_TR-fahrettin-medium', label: 'Fahrettin · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/fahrettin/medium/tr_TR-fahrettin-medium.onnx' },
	{ id: 'tr_TR-fettah-medium', label: 'Fettah · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/fettah/medium/tr_TR-fettah-medium.onnx' },
	{ id: 'uk_UA-lada-x_low', label: 'Lada · Ukrainian · extra-low', language: 'uk_UA', path: 'uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx' },
	{ id: 'uk_UA-ukrainian_tts-medium', label: 'Ukrainian_tts · Ukrainian · medium', language: 'uk_UA', path: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx' },
	{ id: 'vi_VN-25hours_single-low', label: '25hours_single · Vietnamese · low', language: 'vi_VN', path: 'vi/vi_VN/25hours_single/low/vi_VN-25hours_single-low.onnx' },
	{ id: 'vi_VN-vais1000-medium', label: 'Vais1000 · Vietnamese · medium', language: 'vi_VN', path: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx' },
	{ id: 'vi_VN-vivos-x_low', label: 'Vivos · Vietnamese · extra-low', language: 'vi_VN', path: 'vi/vi_VN/vivos/x_low/vi_VN-vivos-x_low.onnx' },
	{ id: 'zh_CN-huayan-medium', label: 'Huayan · Chinese (Mandarin) · medium', language: 'zh_CN', path: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx' },
	{ id: 'zh_CN-huayan-x_low', label: 'Huayan · Chinese (Mandarin) · extra-low', language: 'zh_CN', path: 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx' }
] as const;

export const PIPER_VOICES = VOICES;

/** Sensible first voice for new users. */
export const DEFAULT_PIPER_VOICE = 'en_US-amy-medium';

export function piperVoice(voiceId: string): PiperVoice {
	const found = VOICES.find((v) => v.id === voiceId);
	if (!found) throw new SpeechEngineError('NO_MODEL', `Unknown Piper voice: ${voiceId}`);
	return found;
}

/** All voice ids, for picker tests. */
export function piperVoiceIds(): string[] {
	return VOICES.map((v) => v.id);
}

/** Repo path of a voice's config sidecar (.onnx.json). */
export function piperConfigPath(voice: PiperVoice): string {
	return voice.path + '.json';
}

/** HF download URL for one file inside the piper-voices repo. */
export function piperFileUrl(path: string): string {
	return `https://huggingface.co/${PIPER_HF_REPO}/resolve/${PIPER_HF_REVISION}/${path}`;
}

/** Catalog voices as TtsVoice entries for the picker (en_US first). */
export function piperVoiceList(): TtsVoice[] {
	return VOICES.map((v) => ({ id: v.id, label: v.label, language: v.language })).sort(
		(a, b) => (a.language === 'en_US' ? 0 : 1) - (b.language === 'en_US' ? 0 : 1)
	);
}

/**
 * Model def for one voice's two files (.onnx + .onnx.json), so the generic
 * import flow (ModelStore.importModel / hfResolveUrl) works unchanged for
 * Piper voices.
 */
export function piperVoiceDef(voiceId: string): SpeechModelDef {
	const voice = piperVoice(voiceId);
	return {
		id: `piper-${voice.id}`,
		task: 'tts',
		engine: 'piper',
		repo: PIPER_HF_REPO,
		revision: PIPER_HF_REVISION,
		// Piper has no dtype variants; the field is required by the def shape.
		dtype: 'fp32',
		files: [
			{ path: voice.path },
			{ path: piperConfigPath(voice) }
		],
		sizeBytes: 0,
		languages: [voice.language],
		downloadRoot: 'hf'
	};
}
