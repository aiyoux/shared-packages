import type { ModelDef } from '@shared-packages/model-store';
import { SpeechEngineError, type TtsVoice } from './types.js';

/**
 * Vendored Piper voice catalog (snapshot of @mintplex-labs/piper-tts-web's
 * inline PATH_MAP, 123 voices / 37 languages). The library's own voices()
 * fetches a JSON from huggingface.co, which the hub's COOP+COEP isolation
 * blocks — so the catalog lives here and voice files are user-imported like
 * every other speech model.
 */

export const PIPER_HF_REPO = 'diffusionstudio/piper-voices';
export const PIPER_HF_REVISION = '840e38a7e26d813bd6221b78cfbaefa3585b3f71';

export type PiperVoice = {
	id: string;
	label: string;
	/** e.g. en_US — also the sort/group key. */
	language: string;
	/** Repo path of the .onnx file, e.g. en/en_US/amy/medium/en_US-amy-medium.onnx. */
	path: string;
	/** Bytes and Blake3 of the .onnx, then of its .onnx.json, at the pinned revision. */
	files: readonly [number, string, number, string];
};

const VOICES: readonly PiperVoice[] = [
	{ id: 'ar_JO-kareem-low', label: 'Kareem · Arabic (Jordan) · low', language: 'ar_JO', path: 'ar/ar_JO/kareem/low/ar_JO-kareem-low.onnx', files: [63201294, '7f20dddfd633a9f8f68e6da10141e606aabc532e05a24f8b86203d1b906c1a21', 5022, '2280a93f8b83aa1c6a7fb5a0feaa4e3b4d97c4aba739e2e63c1dc0e119676d4b'] },
	{ id: 'ar_JO-kareem-medium', label: 'Kareem · Arabic (Jordan) · medium', language: 'ar_JO', path: 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx', files: [63201294, '978357e08b6d24fbc4e42f854de27e14b11950ea70c62688258f0684969a2981', 5024, '4876f18a774bcb54e5826ddbfcacd9cf8349af173faa4b448a1a36db281f2da9'] },
	{ id: 'ca_ES-upc_ona-medium', label: 'Upc_ona · Catalan · medium', language: 'ca_ES', path: 'ca/ca_ES/upc_ona/medium/ca_ES-upc_ona-medium.onnx', files: [63201294, '35ba6b8a1ef4b2df56b5265c348d0b08f3c7b96b1c8a8749f4d62d87c39a06e8', 4875, 'f51252e9db7e4dfd2af339157567a338c6583f9c1dc3fa5bc2a54839be61155f'] },
	{ id: 'ca_ES-upc_ona-x_low', label: 'Upc_ona · Catalan · extra-low', language: 'ca_ES', path: 'ca/ca_ES/upc_ona/x_low/ca_ES-upc_ona-x_low.onnx', files: [20628813, '25d7fa10d1e99e597a467e351b0bad8462abf678319851590f2faf26a3d5d6f3', 4159, 'a54d37af8e24e867f6d453acbe48c6466d1b3d6ff59eaab390d494a0cc19a60a'] },
	{ id: 'ca_ES-upc_pau-x_low', label: 'Upc_pau · Catalan · extra-low', language: 'ca_ES', path: 'ca/ca_ES/upc_pau/x_low/ca_ES-upc_pau-x_low.onnx', files: [28130791, '47af28b0f4fcab36b9e047f87d325327414ab95b75732ff7e3492fb8a6fa4bde', 4159, '985b48fc2b905b19d8f51db52ff2374b7ab95c5037b76d134bd0af55ac47f9ed'] },
	{ id: 'cs_CZ-jirka-low', label: 'Jirka · Czech · low', language: 'cs_CZ', path: 'cs/cs_CZ/jirka/low/cs_CZ-jirka-low.onnx', files: [63201294, 'aaf098f4fea58d3d72655ac97c074c9f8dc4283b3115b84c421b1cfc2d3bd575', 5022, '0dedaedb02ccf8ac9b7ba3e65af7b75629343e7e9ba699a44abf0177fad0b45a'] },
	{ id: 'cs_CZ-jirka-medium', label: 'Jirka · Czech · medium', language: 'cs_CZ', path: 'cs/cs_CZ/jirka/medium/cs_CZ-jirka-medium.onnx', files: [63201294, '6e46969454fe866303b89c8a4c82c7587f5b203a9d234ad8a2297b0ea6147c53', 5025, '7ae4d9ad30acb2065a682e283a5ff65b95e73cac964892730593fb3c281e0957'] },
	{ id: 'cy_GB-gwryw_gogleddol-medium', label: 'Gwryw_gogleddol · Welsh · medium', language: 'cy_GB', path: 'cy/cy_GB/gwryw_gogleddol/medium/cy_GB-gwryw_gogleddol-medium.onnx', files: [63511038, '81984ef832515075ca87dd7e4b7b448568e11ec228968b5ad956c10608bf837e', 4975, '3534088980ed8ea91269ee18adc39b86d32050c3df90056f5d3bbfbfde11ea3d'] },
	{ id: 'da_DK-talesyntese-medium', label: 'Talesyntese · Danish · medium', language: 'da_DK', path: 'da/da_DK/talesyntese/medium/da_DK-talesyntese-medium.onnx', files: [63201294, '2b86d516c48dc530fed4e0bb9e390c43eac982a6e3ac0b0ee10785b462bb25a2', 4878, '56207f31c52827aedc246761cb9925b97fdc16286d287d661ae170fd5631483c'] },
	{ id: 'de_DE-eva_k-x_low', label: 'Eva_k · German · extra-low', language: 'de_DE', path: 'de/de_DE/eva_k/x_low/de_DE-eva_k-x_low.onnx', files: [20628813, 'b62970a308d1104b8154496b34fe79198945c6750103024500a0a24cb727cdde', 4158, 'ffc21cf6d21b493682b84bee486275387a334f88fec44ede9a60fab30e01a316'] },
	{ id: 'de_DE-karlsson-low', label: 'Karlsson · German · low', language: 'de_DE', path: 'de/de_DE/karlsson/low/de_DE-karlsson-low.onnx', files: [63104526, '7f77099eef03b6f97f5e2fdec024b5eb5813e27ae4c8c075b9f8c4ca28e9cd8a', 4159, 'e9fb4098cc32525c3d94c2a80539d128ea9bf11d34d31a14bb3f99266d2b7bb6'] },
	{ id: 'de_DE-kerstin-low', label: 'Kerstin · German · low', language: 'de_DE', path: 'de/de_DE/kerstin/low/de_DE-kerstin-low.onnx', files: [63104526, '163b407074bc0c4f8481cfd06f9f16d71448f78401c3ecc4114c10362a4222cb', 4158, 'cd4a548b4c303029e578d472074ced70d5c81ccccd361691a46c20ea4b86e077'] },
	{ id: 'de_DE-mls-medium', label: 'Mls · German · medium', language: 'de_DE', path: 'de/de_DE/mls/medium/de_DE-mls-medium.onnx', files: [76961079, 'ce74d3b4b9b5d1c726977808129867a8c858c1a94179f543741f3972758d92ad', 8948, '2ae7f3dc15cc123caa72f751f79d47e21b3e924c826d8214f921eb85b644289c'] },
	{ id: 'de_DE-pavoque-low', label: 'Pavoque · German · low', language: 'de_DE', path: 'de/de_DE/pavoque/low/de_DE-pavoque-low.onnx', files: [63104526, '4154db84ba457f1f4f38a0c63afecc9dd1b9f5ce0e9ab01c7bfa40e956ed080b', 4158, '5860bfdfa08b70fd1580494952f302a174f800cee358f40b8524149a66408caf'] },
	{ id: 'de_DE-ramona-low', label: 'Ramona · German · low', language: 'de_DE', path: 'de/de_DE/ramona/low/de_DE-ramona-low.onnx', files: [63104526, '3beccc39397a6257bf409ae5bc0cfdf658ae83eb57c35e46a2b0becc462f9f6e', 4157, '9664c1370ee36e4916ece387ce80de0477dbbefc0b41d2ae5e3027d3a529ecb9'] },
	{ id: 'de_DE-thorsten-high', label: 'Thorsten · German · high', language: 'de_DE', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high.onnx', files: [113895201, '73c0cb65006622a5c3bc78cd93ea6cbbc5e3686cbc5bb94eec5afa358b58a7eb', 4875, '44059aeb2dd011cfcf292b45d98bb5faeb02c5df764dd5180a8102dae7e695dd'] },
	{ id: 'de_DE-thorsten-low', label: 'Thorsten · German · low', language: 'de_DE', path: 'de/de_DE/thorsten/low/de_DE-thorsten-low.onnx', files: [63104526, 'a20ae6464d72350abf28bbef472843e0b57cbaae7d4224c20e160e23d8307b94', 4159, '70ba2ed762f04970c53b4026b8bbc75d9b42576ff7d726acb8b73b6b69c0d695'] },
	{ id: 'de_DE-thorsten-medium', label: 'Thorsten · German · medium', language: 'de_DE', path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx', files: [63201294, 'fc0d093deec302eb38e786aa1b55c434a86a584007e45a8959ba57578acd2f3b', 4819, 'a3f7e164e323f40bc1532df65309279b43040f2d118908edb3f9ec59d52f6335'] },
	{ id: 'de_DE-thorsten_emotional-medium', label: 'Thorsten_emotional · German · medium', language: 'de_DE', path: 'de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx', files: [76745905, '65e17189d611d66ae53ddd42bdf18b801fa9709608170e19b12da4f3a3d34677', 5031, 'bdb018ebc5524fad88d34c5577f8f89b837781c24048efb74d89778b1eec7dcb'] },
	{ id: 'el_GR-rapunzelina-low', label: 'Rapunzelina · Greek · low', language: 'el_GR', path: 'el/el_GR/rapunzelina/low/el_GR-rapunzelina-low.onnx', files: [63104526, '3be1a74cb640b40a7635067dacb4a1be710d899eaf84875710f4554ca440652f', 4198, '6996df904c10b67bd6b53311cfb1d0ee552d35f4c50e7429abba771d29edadc2'] },
	{ id: 'en_GB-alan-low', label: 'Alan · English (UK) · low', language: 'en_GB', path: 'en/en_GB/alan/low/en_GB-alan-low.onnx', files: [63104526, 'db3079f9ea58dfea74b574a8fa9f744fcef825e72242e13e7423c832b2457719', 4170, '4820b69e86d4b66b3e4d255807efebdaf0df47755f33fea2e81e74ec99c92025'] },
	{ id: 'en_GB-alan-medium', label: 'Alan · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx', files: [63201294, '68f0286749bd44dff594173e34d8c86424996f485deefbe5d19613bf7affcdbd', 4888, 'd57bb48c33ae1ca29d9e12e157a52d21f37b69aef56fbe6165aea48d2a56d46f'] },
	{ id: 'en_GB-alba-medium', label: 'Alba · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/alba/medium/en_GB-alba-medium.onnx', files: [63201294, '2a47b5f54b9af2b604339ec9bae73e63b3726d36147396ff63a26fc6b7ff935e', 4888, '7454a994bd9e5d90830ba0b175380e8725de78c13877d35c3887104e3e8dd9ca'] },
	{ id: 'en_GB-aru-medium', label: 'Aru · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/aru/medium/en_GB-aru-medium.onnx', files: [76754097, 'e7fac482e7af65882c0022e0db4ba75dc1617ec72b075f5dd2ee54d66592377b', 5048, 'e6a77feb82cdf326f13a31ff5b19ca08383f8a64058e2daa72830b6dcfb29649'] },
	{ id: 'en_GB-cori-high', label: 'Cori · English (UK) · high', language: 'en_GB', path: 'en/en_GB/cori/high/en_GB-cori-high.onnx', files: [114219352, '78667e0143636d83f1e8605da192b89243ab905cabb5ae00e2c91731865ba290', 4963, '6337f364176bff5c691d15b23a0cadb4ffb02b089e61fcb4ae45e2d0e4007784'] },
	{ id: 'en_GB-cori-medium', label: 'Cori · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/cori/medium/en_GB-cori-medium.onnx', files: [63531379, '54697445c80435bd9ee044db4c5c5d2d01aac25dacfa7f36f05bfccf6275a6de', 4966, '883b6be5a3d76805c90089f7acdb0755b1d41c2b2326a2d0096c4522a5ac9793'] },
	{ id: 'en_GB-jenny_dioco-medium', label: 'Jenny_dioco · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx', files: [63201294, 'ae9e615d9f7f72270099a7c6e869cac4c3b3af86494e8cc8ac6cf5052f1f69ee', 4895, '42b7d86ad81168dd2a3fe873b7729d2e7d8cbd3eae89528c005882a0e60250b5'] },
	{ id: 'en_GB-northern_english_male-medium', label: 'Northern_english_male · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx', files: [63201294, '16385f56b9233f501b1b672e5383628bd37def261fe80aae4c44b75845ac32be', 4847, 'a01b2c687220e6f8fdbc23b0e296a5efd75adef2b9af350ec42b44482987ab8f'] },
	{ id: 'en_GB-semaine-medium', label: 'Semaine · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/semaine/medium/en_GB-semaine-medium.onnx', files: [76737711, 'd963194f47345a8a5455c7ea05006bee24838fc7e3891a76362ab6892f1771be', 5076, 'd243b745394abfc5afdbbb712b7b288b9c4053df38f2af66e2cd4e175bba15ed'] },
	{ id: 'en_GB-southern_english_female-low', label: 'Southern_english_female · English (UK) · low', language: 'en_GB', path: 'en/en_GB/southern_english_female/low/en_GB-southern_english_female-low.onnx', files: [63104526, '775e5c0d625572098757701cf0f7b727b0bc22a8d24148a35cd160299ac1ad75', 4189, 'daf953d571d1a2f6a20b538e9e43f01bb27795555cd312c63e2929a7688f5b8a'] },
	{ id: 'en_GB-vctk-medium', label: 'Vctk · English (UK) · medium', language: 'en_GB', path: 'en/en_GB/vctk/medium/en_GB-vctk-medium.onnx', files: [76952753, '0bed1b81e24389fe228fc251dbdae2287d399307ac15df895eb843b8be66a026', 6637, '0b339905e114f8e5355c3df9d692f28944996789bda78a9c2eda194689aa6b2f'] },
	{ id: 'en_US-amy-low', label: 'Amy · English (US) · low', language: 'en_US', path: 'en/en_US/amy/low/en_US-amy-low.onnx', files: [63104526, '16b32e958581feb4c93c60e077bcf04f31e7e18aa50f41242900b13789662a04', 4164, 'fffa8593c54372abb5ecda169670a5e43411735e30cab8bf4ac2b198461c2a91'] },
	{ id: 'en_US-amy-medium', label: 'Amy · English (US) · medium', language: 'en_US', path: 'en/en_US/amy/medium/en_US-amy-medium.onnx', files: [63201294, 'e1ac2a1ade664c86f1e3c9ab3223115469b13bfdd003cc076cd82e483a2b8915', 4882, '76b7f68e333bf4002876336d475966c06a72378c7dad0d1bf1d4f92ff38a7ee8'] },
	{ id: 'en_US-arctic-medium', label: 'Arctic · English (US) · medium', language: 'en_US', path: 'en/en_US/arctic/medium/en_US-arctic-medium.onnx', files: [76766385, '761fdff451194db39721db88bc78796001d3ca94911ad8d5c33451e6cc314f78', 5148, '53fc0f48706742c73849d6d1ec3c358cc3f8a80ed537c67127d1e1698787733d'] },
	{ id: 'en_US-bryce-medium', label: 'Bryce · English (US) · medium', language: 'en_US', path: 'en/en_US/bryce/medium/en_US-bryce-medium.onnx', files: [63531379, '81e711f5360e028faae18e04d7de6e377021215eee14346e99ed668bbfc214bd', 4966, '99d91cc12429f5746704689d234fa58eb3597e3faf71f7a79d4c5c56094390dc'] },
	{ id: 'en_US-danny-low', label: 'Danny · English (US) · low', language: 'en_US', path: 'en/en_US/danny/low/en_US-danny-low.onnx', files: [63104526, '236d5d05cd511cedfc88832bee1804b7de360b3d9071680695cea4b9679a72f3', 4166, 'aefea1892b112e225974bd272f1b36ba67cf435d7bd43a048aca53a0a7bf2d23'] },
	{ id: 'en_US-hfc_female-medium', label: 'Hfc_female · English (US) · medium', language: 'en_US', path: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx', files: [63201294, '7ba0f4c904fcfba3158c31db431561b3c5ca27996deae3a9c1e9a4a12cf9d881', 5033, 'e7b8a7b81928d4cb2f8af82b75748b3d7ee246e317af50097a592256dd4729b1'] },
	{ id: 'en_US-hfc_male-medium', label: 'Hfc_male · English (US) · medium', language: 'en_US', path: 'en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx', files: [63201294, '18acaea05c3ffdc2c4f6fe8e1d3dec9e89b51b1d86f8e67af1ec20b27ae5ffa8', 5033, '88f81b46596061ce92921174b6fda92577397165ab5a9f0a00f5eb1ee223d246'] },
	{ id: 'en_US-joe-medium', label: 'Joe · English (US) · medium', language: 'en_US', path: 'en/en_US/joe/medium/en_US-joe-medium.onnx', files: [63201294, '60f8957c87906d19e78f35b44f905ad920f216a7a9158de2519960afc1291725', 4794, '5c7874946b8428e7d3d02f55f4c98056aaac2040f9caef917cc9b8c81e41b337'] },
	{ id: 'en_US-john-medium', label: 'John · English (US) · medium', language: 'en_US', path: 'en/en_US/john/medium/en_US-john-medium.onnx', files: [63531379, '0936f6f94cba401127d33895615fd8d007f1d49840cbcf7101cc04cb2dd1dd8b', 4965, '18e5517acc1ebe561a995983b5e0c0f6d7b9646cc7b7265468c9863dd6b096d6'] },
	{ id: 'en_US-kathleen-low', label: 'Kathleen · English (US) · low', language: 'en_US', path: 'en/en_US/kathleen/low/en_US-kathleen-low.onnx', files: [63104526, 'd084bd044584cf051963a23eb5ff931f7e9198bffeff8fb0f0a7ba4cf843ab24', 4169, '5faf7ddcdbf3b899ebc04cbb04e9dc1de9da7a70fdca0b5afff74293ee3874af'] },
	{ id: 'en_US-kristin-medium', label: 'Kristin · English (US) · medium', language: 'en_US', path: 'en/en_US/kristin/medium/en_US-kristin-medium.onnx', files: [63531379, 'e2fd171cf54bb7dbc9a8f47bf9c2b0d9f393df65811d748ea7afac83824f7485', 4968, '10a9442161af52c9476853ead39f1b06910dcf32c8d0caeef59ab2a9753a3f0f'] },
	{ id: 'en_US-kusal-medium', label: 'Kusal · English (US) · medium', language: 'en_US', path: 'en/en_US/kusal/medium/en_US-kusal-medium.onnx', files: [63201294, '79311f959b6358f3406ff5718f2d20023b049183add2c4f031f72f0bd5642032', 4884, 'fb6960592028f13fedcc8bc30e85621b263c27ba529a04d094a3148287990cd0'] },
	{ id: 'en_US-l2arctic-medium', label: 'L2arctic · English (US) · medium', language: 'en_US', path: 'en/en_US/l2arctic/medium/en_US-l2arctic-medium.onnx', files: [76778673, '644afc1449d4c15680a3163b50c860886367d8b964a6d0205ec7a5fbb6482e2c', 5252, '989c2798a303fe6a30b06f8c8235af127e62de2597ce015ef945f8d434bc464a'] },
	{ id: 'en_US-lessac-high', label: 'Lessac · English (US) · high', language: 'en_US', path: 'en/en_US/lessac/high/en_US-lessac-high.onnx', files: [113895201, 'a34fde6777885b18088b9b15812142d6d9addfc47b9c05006580dff348f3ffc3', 4883, '49ecc293c21b9ab9ba510a6ebb646d30b8a0e1ec6893c41e3b475afd01128c00'] },
	{ id: 'en_US-lessac-low', label: 'Lessac · English (US) · low', language: 'en_US', path: 'en/en_US/lessac/low/en_US-lessac-low.onnx', files: [63201294, '035ce610e75103dd538189d19d50a01603c7c4d1fbe930367d591824441f8e38', 4882, 'e285c21d60afebf83340cc681a802c279c8162281674f9dd84ae943d8edd1f8c'] },
	{ id: 'en_US-lessac-medium', label: 'Lessac · English (US) · medium', language: 'en_US', path: 'en/en_US/lessac/medium/en_US-lessac-medium.onnx', files: [63201294, '9b2fd0bbd023263e55b2813b9ede2aa0863610d3cb82cfcc0ecaf0b53e5944ee', 4885, '0b56efada37aa3676d0e196c9ceee69751b6f4a48b81734c99f243e252547be8'] },
	{ id: 'en_US-libritts-high', label: 'Libritts · English (US) · high', language: 'en_US', path: 'en/en_US/libritts/high/en_US-libritts-high.onnx', files: [136673811, 'd27fcbefbf0b9232374980d09fb104e305840bd037cd6baaf692b69e4c228f39', 20163, 'eb8e87ab1dc9c82bd4100c36f25008859adba7023c51efc9f3e1e1d85de2d9ff'] },
	{ id: 'en_US-libritts_r-medium', label: 'Libritts_r · English (US) · medium', language: 'en_US', path: 'en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx', files: [78580914, '43608e5c7dfd5cc00660a2c67783f752f0c93217bf1d27e15454cb957f6f55ac', 20123, '6c75327cfbb14ff2db4c26c3bc73458bcd9709194e4352d9ff184e9955b094c5'] },
	{ id: 'en_US-ljspeech-high', label: 'Ljspeech · English (US) · high', language: 'en_US', path: 'en/en_US/ljspeech/high/en_US-ljspeech-high.onnx', files: [114199011, '1ca2c514e9d8c8aec3d0e923ded48d4c362047abba6403f14cad08ff55508fc0', 4970, 'ee6472b661bac25cb9671d8ce7d29bd3aaeb49d767594e3d4546597cb7f97bfa'] },
	{ id: 'en_US-ljspeech-medium', label: 'Ljspeech · English (US) · medium', language: 'en_US', path: 'en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx', files: [63531379, 'fe1bb68f9de13a471aad569c146be2567dc638813d85addd04d8a83f10303651', 4972, '4c1793008ee34a4a062b70a386d0269f3a573879a0fda50812bd05c7f11e67ce'] },
	{ id: 'en_US-norman-medium', label: 'Norman · English (US) · medium', language: 'en_US', path: 'en/en_US/norman/medium/en_US-norman-medium.onnx', files: [63531379, '13e79a558968da650f9d0f0310cfeaee9053a7200b396f8a1e87e01b3f291fa6', 4968, '0ae5c1a88af3fafb70f13c7736dd5dcdd84272a8b161466f32cd9ba124ff452c'] },
	{ id: 'en_US-ryan-high', label: 'Ryan · English (US) · high', language: 'en_US', path: 'en/en_US/ryan/high/en_US-ryan-high.onnx', files: [120786792, '77f5d164e463d93dad9407928a1cc5632b1a96410938b77bf44fb4fc833e2e5a', 4166, 'd787fb4dc19c4a65443077a10e9331e967d873b7aad205f5e875a962e4cb9cea'] },
	{ id: 'en_US-ryan-low', label: 'Ryan · English (US) · low', language: 'en_US', path: 'en/en_US/ryan/low/en_US-ryan-low.onnx', files: [63104526, '0f3064ba7d8d77a89f9b3b5f8bd8a2d08794a33551841791193b602824061a15', 4165, '78c07be39984970b990343b15db2bfcc49e446dcd63427881142f4e043b5bd6d'] },
	{ id: 'en_US-ryan-medium', label: 'Ryan · English (US) · medium', language: 'en_US', path: 'en/en_US/ryan/medium/en_US-ryan-medium.onnx', files: [63201294, 'd61417c7b76ae5fcc5700ecef52e3d7d63962baf632eacef518918c5ebce781b', 4883, '28e3ad4d9bfd2e84863bec478b142f2a5181ab19b037baeaa21a593e10c5b96d'] },
	{ id: 'es_ES-carlfm-x_low', label: 'Carlfm · Spanish (Spain) · extra-low', language: 'es_ES', path: 'es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx', files: [28130791, '47653a21c120bee12b5f4e6e57b813d3b25d48b151839adcf2c9eeeaa7e0bc13', 4159, 'b890798dc1b52045ed8bbebde315e79cb556de66c0ff678532b0a0a2fc82fcd0'] },
	{ id: 'es_ES-davefx-medium', label: 'Davefx · Spanish (Spain) · medium', language: 'es_ES', path: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', files: [63201294, '3048e7dcd9fad128b75c9eadfabc359c67a924745a3536cc9c2f0e165c5dd417', 4817, 'fecc368d0445ab9e0d88090036b70fa6575bff77c7e5784b3ae39c9d1304fe1f'] },
	{ id: 'es_ES-mls_10246-low', label: 'Mls_10246 · Spanish (Spain) · low', language: 'es_ES', path: 'es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx', files: [63104526, 'be1b9623a9fac528b2473b3d2d285a0bfa92313133c0ff3b62140d6697d09b8a', 4160, 'b15238d87e2d52533a6a5c194d8e26d6016b7a461cd6fc00bdefdd1f9b48ccc3'] },
	{ id: 'es_ES-mls_9972-low', label: 'Mls_9972 · Spanish (Spain) · low', language: 'es_ES', path: 'es/es_ES/mls_9972/low/es_ES-mls_9972-low.onnx', files: [63104526, '5f2aff437611804c0c3670c2fa789cd64704c7448c20c7dfa7ded0410a1981f8', 4159, '05ae686be2dd606ad96bd7db0c9a816ada97f165f6bdfdc01004f6d04fbc1438'] },
	{ id: 'es_ES-sharvard-medium', label: 'Sharvard · Spanish (Spain) · medium', language: 'es_ES', path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx', files: [76733615, '23c91539cf0312891aba27a76a9bfb5ee229a0a71974fef107faf86bd5c11334', 4903, '09d623770a2f4451b80e173606960768611b2a58365934ff7ab4fafafe859a50'] },
	{ id: 'es_MX-ald-medium', label: 'Ald · Spanish (Mexico) · medium', language: 'es_MX', path: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx', files: [63201294, '7ea5b843d5f703e4a2f254605a723c3a3c5e6ca298958ade49e6783b354c35d4', 4889, '6261a3aacbe9b73f1a6bf35be14893091b2a44eaeab642c3326890f03b47aef9'] },
	{ id: 'es_MX-claude-high', label: 'Claude · Spanish (Mexico) · high', language: 'es_MX', path: 'es/es_MX/claude/high/es_MX-claude-high.onnx', files: [63122309, '7d57b2feda139c0febd30e7ee0ef2c047214af6eb7f705ce5f9278c1f282b46c', 4963, '9eeecda770d0ca4cf533ec6a60112ba8eb5edf09da783c2d94c17254b9e3f652'] },
	{ id: 'fa_IR-amir-medium', label: 'Amir · Persian · medium', language: 'fa_IR', path: 'fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx', files: [63531379, 'e766e9091540c81d2e95f95583188f895ad92d667cfdfe112d4b437b0fb5b20a', 4958, 'de941a0c796d3842022520859a0a23f712f555b2b8699327439c5f6db72a0803'] },
	{ id: 'fa_IR-gyro-medium', label: 'Gyro · Persian · medium', language: 'fa_IR', path: 'fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx', files: [63122309, 'f5071d4bc754135a70611c290df9fc1c9cd6658c3c8a0664061ff496f85bff8c', 7210, '16229293bc3534c8703d15c340da466988e515c7d1c320f088a1df8df6bb2da0'] },
	{ id: 'fi_FI-harri-low', label: 'Harri · Finnish · low', language: 'fi_FI', path: 'fi/fi_FI/harri/low/fi_FI-harri-low.onnx', files: [69795191, '8c24ea809ecb900ea21cfc1750c283bfa50de3dba0708445e66d76636981c258', 4155, 'b75caee15987ebf6eb6f8e0852bea39762b2a44e4bb40456148e9f0df35f1e0d'] },
	{ id: 'fi_FI-harri-medium', label: 'Harri · Finnish · medium', language: 'fi_FI', path: 'fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx', files: [63201294, 'c8aeb9aa09062c87c0c6bd5ab958236cb2087b00f55a98b97f591ed8ac7356b0', 4873, 'dbf9ebb2a8c7b7b7d86dde3e66080353e4febab2510eca7b35189a429eb6e62e'] },
	{ id: 'fr_FR-gilles-low', label: 'Gilles · French · low', language: 'fr_FR', path: 'fr/fr_FR/gilles/low/fr_FR-gilles-low.onnx', files: [63104526, '4b0fc73025bec8f53e788ab50db84f7df9765eaacc4a4c79421f32f8ec084855', 4158, 'fd72183c1d7e2da946df63c03169c981140bdbe03a7afca326299e1ff9bd9040'] },
	{ id: 'fr_FR-mls-medium', label: 'Mls · French · medium', language: 'fr_FR', path: 'fr/fr_FR/mls/medium/fr_FR-mls-medium.onnx', files: [76733750, '876cf79c8f8cac9cd6d2b0206c30f83f7f9ccdd48d04ea6a3f66fbcbfcf0d5ac', 7036, '4fe6eba08c1475fc72d25935dc4e32762940ac310410449b37459b1de0190d5b'] },
	{ id: 'fr_FR-mls_1840-low', label: 'Mls_1840 · French · low', language: 'fr_FR', path: 'fr/fr_FR/mls_1840/low/fr_FR-mls_1840-low.onnx', files: [63104526, '795d416e8dd04ecf8b540ea3206af6f5a74176b3d862d5181497c70a6738d11e', 4160, 'f06132af5bd064b8f2d5dd6079275be86d4402fc9559c59c7fed3f7378d4cb5d'] },
	{ id: 'fr_FR-siwis-low', label: 'Siwis · French · low', language: 'fr_FR', path: 'fr/fr_FR/siwis/low/fr_FR-siwis-low.onnx', files: [28130791, '8fb8dd690ac235fcda0f7db3d76f428a2a2615410fcecc65500b8cbe9f331e8d', 4157, '4d581a631c9745d0171bff5c9d9abce2f272c254b048430fbfe79e71d31109d0'] },
	{ id: 'fr_FR-siwis-medium', label: 'Siwis · French · medium', language: 'fr_FR', path: 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx', files: [63201294, 'f946f2ff8151ff6f26ffc7099caf246d6347ed3202b72296c34a05f31f924271', 4875, '2467b5454250f10804fc0c9ebcd44769c16f71f4edcbca6e88c8ea01898a76df'] },
	{ id: 'fr_FR-tom-medium', label: 'Tom · French · medium', language: 'fr_FR', path: 'fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx', files: [63511038, 'c1d65f1fed67e754f2aa5a54dd94d422356cfded541556d9e3c6a6f08ad6937e', 4959, '50ec24cb0b588cb4f2784d1cef12bfad60fc70452ec76f09116c3a0088764345'] },
	{ id: 'fr_FR-upmc-medium', label: 'Upmc · French · medium', language: 'fr_FR', path: 'fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx', files: [76733615, '5eb6063f9fd25fbf2bc1ecefc9a33d9814e10bc46ffb44aaec2a86eeb96674a3', 4996, 'd6fa4edd49ef0f93437b96771bc37a6daa80d794298229ef3410d4c422dc05fb'] },
	{ id: 'hu_HU-anna-medium', label: 'Anna · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/anna/medium/hu_HU-anna-medium.onnx', files: [63201294, '08abf4028289cbb584475cc85e7f3acc08fc18c868cfb37cdc297810a3964333', 5018, 'ad7bf7d583e55ce91ca1850c7c2a7248b7bd3c052d0801dea98b8ecd261a5ac3'] },
	{ id: 'hu_HU-berta-medium', label: 'Berta · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/berta/medium/hu_HU-berta-medium.onnx', files: [63201294, 'b5c6169ef0f244f8cc0a119cba4ec96b2b06009fed4df8fc7dd5bb8e7527e893', 4961, '3788667176c84f2251303cbcb00bec70126d75689a89b820f4a46c2cc49c09f9'] },
	{ id: 'hu_HU-imre-medium', label: 'Imre · Hungarian · medium', language: 'hu_HU', path: 'hu/hu_HU/imre/medium/hu_HU-imre-medium.onnx', files: [63201294, 'f77f93909c46e821ba1d9bdf428e283a61cdc6974920da3dada00b6f4a44395d', 5019, 'd36b059e1a6b94dccf24bfd7de62801c3e6f067cd7dedd8a0d86579318fc244d'] },
	{ id: 'is_IS-bui-medium', label: 'Bui · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/bui/medium/is_IS-bui-medium.onnx', files: [76495465, '181135770039ad1269242c40339f9d48b14909435921d402fc49bc26fd5b55d1', 4162, 'ed123f7030597cd2592843df98e7de85c923e35609bacdae50cd032cc0d520f4'] },
	{ id: 'is_IS-salka-medium', label: 'Salka · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/salka/medium/is_IS-salka-medium.onnx', files: [76495465, 'f9a134930750685ca43d2b87d67a0218ed5b82bafbc6ae2fc389bf237b0fa08c', 4164, 'f95e23d29f005bd213f4fdd4f3835a7d40827b09bccfadb69b4e590b9865d116'] },
	{ id: 'is_IS-steinn-medium', label: 'Steinn · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/steinn/medium/is_IS-steinn-medium.onnx', files: [76495465, 'd6ce3457e94968569b6a47f23eb721ebb3b13affe7d1d0e8d8de4017f839fb39', 4165, '7cc033a8c3564dde45e25eb9dd8a295ca4f2fb02d684f84bf3cef8736ac81d99'] },
	{ id: 'is_IS-ugla-medium', label: 'Ugla · Icelandic · medium', language: 'is_IS', path: 'is/is_IS/ugla/medium/is_IS-ugla-medium.onnx', files: [76495465, '77ed2c4657814ce48024424ade573733c302d7bf0839b9909836c8477789137e', 4163, '54d608fdb4e165fa0911a6b6fb2f7eb5ce943bf04aa90186939fb7fd83f0197b'] },
	{ id: 'it_IT-paola-medium', label: 'Paola · Italian · medium', language: 'it_IT', path: 'it/it_IT/paola/medium/it_IT-paola-medium.onnx', files: [63511038, 'ae170a5d384ec87bb1dc2880f354c26051b815ffaf98bcf21f8c6614f86ce7b7', 7099, '215f830c0567d08538d0346c2cf5088506a6676b84754f95d4b136d5c3dbc9cc'] },
	{ id: 'it_IT-riccardo-x_low', label: 'Riccardo · Italian · extra-low', language: 'it_IT', path: 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx', files: [28130791, '94332116cfe0ac4a84b195785ae430319fa890ee5815dc610a1e3729d43580ec', 4161, 'c58052272bd495bc356dc187cceac0c2fc64618034d355201f6556ee92bfe78d'] },
	{ id: 'ka_GE-natia-medium', label: 'Natia · Georgian · medium', language: 'ka_GE', path: 'ka/ka_GE/natia/medium/ka_GE-natia-medium.onnx', files: [63201294, '17212cb42b920afb688b3e6ad18bbe99b172dad794526122bacd42d7c869163f', 4842, '7926f40c8bb651e39d325026d8e58ad18cccd0378c1a8ef145e816ed181b0327'] },
	{ id: 'kk_KZ-iseke-x_low', label: 'Iseke · Kazakh · extra-low', language: 'kk_KZ', path: 'kk/kk_KZ/iseke/x_low/kk_KZ-iseke-x_low.onnx', files: [28130791, 'e103e6640e30d93cff3492358b58cddee0876c7e5783994f2db365087b6d0e42', 4168, '19e25169547fd7ed987c60ecf6beb24404dadba0bf153e7f7a6b4e0b1e6db1ce'] },
	{ id: 'kk_KZ-issai-high', label: 'Issai · Kazakh · high', language: 'kk_KZ', path: 'kk/kk_KZ/issai/high/kk_KZ-issai-high.onnx', files: [127864258, '6ca1978bc016251fc2c958fb310fa748e07e85196e3b393ddb14034c243897cb', 4358, '6550e831df0675c0818fb4c38d8ae12c13ed9a7d2df95b3a272a5248842d1f83'] },
	{ id: 'kk_KZ-raya-x_low', label: 'Raya · Kazakh · extra-low', language: 'kk_KZ', path: 'kk/kk_KZ/raya/x_low/kk_KZ-raya-x_low.onnx', files: [28130791, 'e920f564babec1e859aabd4ada090d24e41795e64a428d3b47b860ff4dfe0a8d', 4167, '298c037b32c09a55fb1317052a79f0d7041776d4aba5e3769db40de63cdedfae'] },
	{ id: 'lb_LU-marylux-medium', label: 'Marylux · Luxembourgish · medium', language: 'lb_LU', path: 'lb/lb_LU/marylux/medium/lb_LU-marylux-medium.onnx', files: [63201294, '6eb1d1dbb56d6e05954461d62089a2ff2e9017190d76dd9e534d728a1e381766', 4979, 'f93a398025ced54ee83d1176c0eb8da961bf48f198a186d0e396e609e3851742'] },
	{ id: 'ne_NP-google-medium', label: 'Google · Nepali · medium', language: 'ne_NP', path: 'ne/ne_NP/google/medium/ne_NP-google-medium.onnx', files: [76766385, 'd744e04180631ffd8ad5eee210c3df733b8fcd4f9f80ff45dfa2289c397809e2', 5165, '4ff714b8345d2d95e437a48b6622a9bbfe924f7d8467214e0613fa89f696fad3'] },
	{ id: 'ne_NP-google-x_low', label: 'Google · Nepali · extra-low', language: 'ne_NP', path: 'ne/ne_NP/google/x_low/ne_NP-google-x_low.onnx', files: [27693157, 'cb892119a4abfb302624849a3e02d30a2bacf86dc0dc880f392dc8f155b04f89', 4449, '31f7e443ee17288d40d11d21e4f62cc4b225c4e680e96a5705cb5406e1ebc32d'] },
	{ id: 'nl_BE-nathalie-medium', label: 'Nathalie · Dutch (Flemish) · medium', language: 'nl_BE', path: 'nl/nl_BE/nathalie/medium/nl_BE-nathalie-medium.onnx', files: [63201294, '92aef48071f4addaf7d7738230b5157e6189d8d27915267a000f8bbcb0213593', 4879, 'c3d7a7956f1bb1fd9e176e9ba78fe6390f90dd7693ce4da388a16a1cafba7076'] },
	{ id: 'nl_BE-nathalie-x_low', label: 'Nathalie · Dutch (Flemish) · extra-low', language: 'nl_BE', path: 'nl/nl_BE/nathalie/x_low/nl_BE-nathalie-x_low.onnx', files: [20628813, 'f12249a9b6570faaef12e6d9926ba85c2adc7e972eb2fe43e96a285ec5ba2039', 4163, 'd7c2b4f2f8fc8b0e574fd9043a9851d7af060d5a7450de2c5d586284d5066fe5'] },
	{ id: 'nl_BE-rdh-medium', label: 'Rdh · Dutch (Flemish) · medium', language: 'nl_BE', path: 'nl/nl_BE/rdh/medium/nl_BE-rdh-medium.onnx', files: [63104526, '9c6ba1530368471fa6a9f2aed8ae01eae35101da7fb2c100aaf7ba0c53a60c0a', 4159, '7d6c8a9305b7c24b40004d600ed5d8f19670b41889adb2499ad8a281698337ea'] },
	{ id: 'nl_BE-rdh-x_low', label: 'Rdh · Dutch (Flemish) · extra-low', language: 'nl_BE', path: 'nl/nl_BE/rdh/x_low/nl_BE-rdh-x_low.onnx', files: [20628813, '5fb97ebd22a85c1a2512d907d27df80146b3e617598a4662fc90f51aafc7ba1f', 4158, 'd030d4fe694222a5cd94dbf05fb850ffad8b4d4021d42c7ab35d75c3401d8a8a'] },
	{ id: 'nl_NL-mls-medium', label: 'Mls · Dutch · medium', language: 'nl_NL', path: 'nl/nl_NL/mls/medium/nl_NL-mls-medium.onnx', files: [76584246, 'bd4ff794d024db4156781080a753678554655f0bb78da366555aad11d451451c', 5856, '9dde8b69e41d903338c9ebd4ad92086bfdfd03b1c54a0a95d3b26166997d8b50'] },
	{ id: 'nl_NL-mls_5809-low', label: 'Mls_5809 · Dutch · low', language: 'nl_NL', path: 'nl/nl_NL/mls_5809/low/nl_NL-mls_5809-low.onnx', files: [63104526, '814f6604df6e59f01c4a82c60fcbab69664aa7ea625644eedc8eb9f4171ff40e', 4165, '9a7a939f62cb80872fdc0082fe21c58091def0a0da0a332a5ce7111c095f85aa'] },
	{ id: 'nl_NL-mls_7432-low', label: 'Mls_7432 · Dutch · low', language: 'nl_NL', path: 'nl/nl_NL/mls_7432/low/nl_NL-mls_7432-low.onnx', files: [63104526, '0f408caae4be1f36f4a8d990b0b82123078df407f26afbf93151f9a1ba22ebea', 4165, '6fef131fd33f36ba57d81e32cd33fa8b8fa155c002cf2428a537e325e50d004e'] },
	{ id: 'no_NO-talesyntese-medium', label: 'Talesyntese · Norwegian · medium', language: 'no_NO', path: 'no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx', files: [63201294, '749c6fbcb0131ad6d84547fd0465b89a648704ab3686644f08e25264299ec6f6', 4880, '9d30add6914895315f32bd72b923234364ea297b8c637bbd04f2b88f34ae79d1'] },
	{ id: 'pl_PL-darkman-medium', label: 'Darkman · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx', files: [63201294, '7554030dd8b3cd40529098054600dc7194f4d146e29fc24f89b89a94c7a43df4', 4816, '676368efab0361f480481cc41d558293bed023362bdc838b8a7810d0d8ff4403'] },
	{ id: 'pl_PL-gosia-medium', label: 'Gosia · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx', files: [63201294, 'cec3f38aa9c14d2dfbe43465e818253ee0ed05854288cde7bfda7131acc4fa1b', 4814, '0e374abd03554f389371cd85dc4a7f69c8adec8055ec0cc4ede264db0510b4cb'] },
	{ id: 'pl_PL-mc_speech-medium', label: 'Mc_speech · Polish · medium', language: 'pl_PL', path: 'pl/pl_PL/mc_speech/medium/pl_PL-mc_speech-medium.onnx', files: [63201294, '9ee4676f29dc7125a591f7eb1bdd7a26808040183b3629a7cef56e158fc9132d', 4961, '3cd855df8cc5feeceb0bdd05c6c76a9a9e3b8dc58a86616f5e7e83e3b6f4fb78'] },
	{ id: 'pl_PL-mls_6892-low', label: 'Mls_6892 · Polish · low', language: 'pl_PL', path: 'pl/pl_PL/mls_6892/low/pl_PL-mls_6892-low.onnx', files: [63104526, 'e9e2971ac7132984c6f6958c21501dec46638332b9e1bcc113a417aead270cde', 4157, '980abc470ed30ce02694e3edb9eaaa007603b5d7a3ed4fd37b5a4fa84c806cc6'] },
	{ id: 'pt_BR-edresson-low', label: 'Edresson · Portuguese (Brazil) · low', language: 'pt_BR', path: 'pt/pt_BR/edresson/low/pt_BR-edresson-low.onnx', files: [63104526, 'daa861bb871e0875029086cfd5fbe5b4d4f8aa2dd6090c444c9bef34d04693ec', 4168, 'af27c95a01819b089573e6451b5b95dff4c58a92287848b3b40368ed36f16c6b'] },
	{ id: 'pt_BR-faber-medium', label: 'Faber · Portuguese (Brazil) · medium', language: 'pt_BR', path: 'pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx', files: [63201294, '2d3e4c142232883f05979940f58d7d036237a820ba41fdac3d8c1fd1be4b22e5', 4855, '4bb56a2420f2aeb40300daac78881e81d49c391507cd247ec544e11ab9c3fcdb'] },
	{ id: 'pt_PT-tugão-medium', label: 'Tugão · Portuguese (Portugal) · medium', language: 'pt_PT', path: 'pt/pt_PT/tugão/medium/pt_PT-tugão-medium.onnx', files: [63201294, 'f3563c49d086e75422d9f8a9d93374cf34af9514ea9314d4b7f44ddbfd134e06', 5026, '287e35d3cbc185e082d8948eee433a1252e5982d4da6d47a4ac5377f3b74a078'] },
	{ id: 'ro_RO-mihai-medium', label: 'Mihai · Romanian · medium', language: 'ro_RO', path: 'ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx', files: [63201294, 'ab72b2d1b91a0dd1fdee26cd3168d11c74f168b17577277ee5cce17926d92e5c', 4877, 'd008b375361cbc66f81eae8e908ace893f90ebae993586243a1dd3b15c75139e'] },
	{ id: 'ru_RU-denis-medium', label: 'Denis · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx', files: [63201294, '2e64d8717563fd10df2ce516e7b590be0f6e819485eaa166aa9e28922e237ec7', 4823, '37a27cb69f55b550f2f9b7ba03735b2226845cd83da5fac1cc62baa9958b8650'] },
	{ id: 'ru_RU-dmitri-medium', label: 'Dmitri · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx', files: [63201294, '92e854798196716489c1185769fac0dcec3dd792e8d82d76986cd65788827839', 4824, 'cec31a840d319c58cc5919333456354579db78a2084cf346a9c095740c9c6117'] },
	{ id: 'ru_RU-irina-medium', label: 'Irina · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx', files: [63201294, 'da1c648b2dbfd8910470c6ac97a15ce5883e4749c99742b5a947b10a9b2a39db', 4765, 'd8fc0e6ac18c10ca4de677754df8dea14c7ab01fab17ac35815b394369ba0fe5'] },
	{ id: 'ru_RU-ruslan-medium', label: 'Ruslan · Russian · medium', language: 'ru_RU', path: 'ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx', files: [63201294, 'c6fe9552c5dd6c0f279ac8094021ea386bac0e442d8d9a7cabcfea8fd5803aad', 4882, '81eb1158958384c522324755773adaf7c3b1deda3c9701f1552047b0ea831e0f'] },
	{ id: 'sk_SK-lili-medium', label: 'Lili · Slovak · medium', language: 'sk_SK', path: 'sk/sk_SK/lili/medium/sk_SK-lili-medium.onnx', files: [63201294, '685aeb826a4c15ec0860f7554c6f2ed8cd941f2a6ccbbffa1d09b2824be60129', 4963, '3df6d427b167e19c60eb752dfafbb45b7082ba6a2a9d224b10d37ce017e30f63'] },
	{ id: 'sl_SI-artur-medium', label: 'Artur · Slovenian · medium', language: 'sl_SI', path: 'sl/sl_SI/artur/medium/sl_SI-artur-medium.onnx', files: [63200492, 'a3299d2ebdeb578a9cd730becb69e0cca57d1500cc995402016aec30919a7aa5', 4970, 'd3b503002badb524c6ede3849d137945d01acfa209d23a9e68a9497d46f0465c'] },
	{ id: 'sr_RS-serbski_institut-medium', label: 'Serbski_institut · Serbian · medium', language: 'sr_RS', path: 'sr/sr_RS/serbski_institut/medium/sr_RS-serbski_institut-medium.onnx', files: [76733615, 'd3d1446c7c4716875553b06a13fadafca883eca7dbb0a5fa81d8f763def64e52', 4999, '8427febd2b5e59a78742bb53a3f8cf1c5a8db1fe37ccc8bac7bcc6742c57efe0'] },
	{ id: 'sv_SE-nst-medium', label: 'Nst · Swedish · medium', language: 'sv_SE', path: 'sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx', files: [63104526, 'f25e2e3e8ad7fec3ff85191382eb67a85a5528a3135f796766165b8df130a786', 4157, '1fbe4aed33ba2f9e98692221a34be262e0e2623fe02f1f5983551e2b2ac92286'] },
	{ id: 'sw_CD-lanfrica-medium', label: 'Lanfrica · Swahili · medium', language: 'sw_CD', path: 'sw/sw_CD/lanfrica/medium/sw_CD-lanfrica-medium.onnx', files: [63201294, '9fff847eb18c76ba71233cccf5d5a2958c9e02e4503e60090373a3c3837fcd4b', 4905, '40ce96d9397829f5220622fcce258737cee7414f8f48a5615bd5c26fc70baa93'] },
	{ id: 'tr_TR-dfki-medium', label: 'Dfki · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx', files: [63201294, 'd9731081749813183d40512fa6858e4bdab56262ee67065ee7e33789058594a0', 4960, 'c547997d79ccf8aeb8a4f18a22e6746f3219a860fcf79cdfb623e6f1ba1e142c'] },
	{ id: 'tr_TR-fahrettin-medium', label: 'Fahrettin · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/fahrettin/medium/tr_TR-fahrettin-medium.onnx', files: [63201294, '34cf763f763391403d10cba49bbb921ab856f58b7ef432203178fcf2bd0d544a', 5022, '6b4d7dcc9875351e5cbe48f4ef8f4556ecdb0b204a9fe16ab7eb2531858dfc31'] },
	{ id: 'tr_TR-fettah-medium', label: 'Fettah · Turkish · medium', language: 'tr_TR', path: 'tr/tr_TR/fettah/medium/tr_TR-fettah-medium.onnx', files: [63201294, 'd79bb13b622d20335d789c688871a4fc0c9385c1fb23161cfc59f5bba0e05b64', 4877, '5162f8e165265251093e134e30ec957987f8b4992475d70431c03b2dba92d770'] },
	{ id: 'uk_UA-lada-x_low', label: 'Lada · Ukrainian · extra-low', language: 'uk_UA', path: 'uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx', files: [20628813, '2bb98c70f343da8215f6d29e5352d50615a38d73a91ad4a412eb7d13c4b40697', 4186, 'cbcf5a735c6fea9b0a6489af56bfeadffc4ff37a5419a9d2283f7dfc37921448'] },
	{ id: 'uk_UA-ukrainian_tts-medium', label: 'Ukrainian_tts · Ukrainian · medium', language: 'uk_UA', path: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx', files: [76735663, 'feb53ecdce981f3504fce01135c2f46617eebef3ef5949a77718cea1e874f39d', 2002, '01d50cbcb481b3595bb40be9eb63b035d169ce19dd54c14bf6413bf7bbcc419f'] },
	{ id: 'vi_VN-25hours_single-low', label: '25hours_single · Vietnamese · low', language: 'vi_VN', path: 'vi/vi_VN/25hours_single/low/vi_VN-25hours_single-low.onnx', files: [63104526, 'ba02d411ff96f1509984d61c514a0eb8b332c7f8cd59859f8d221547515d0c17', 4176, 'a04d9b66a47f0833232b75a0e3022af4d0afa4212d960635340f2e6af157a046'] },
	{ id: 'vi_VN-vais1000-medium', label: 'Vais1000 · Vietnamese · medium', language: 'vi_VN', path: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx', files: [63201294, 'd82296bdf909163dadcc66d20314f126589e3070ccdae720b8f28d365643fce8', 4860, '112c2fe1c75a69db88158b9440ec0a472ffcca2077c20d3787e92ea92ad2c648'] },
	{ id: 'vi_VN-vivos-x_low', label: 'Vivos · Vietnamese · extra-low', language: 'vi_VN', path: 'vi/vi_VN/vivos/x_low/vi_VN-vivos-x_low.onnx', files: [27789413, 'aca4c8e2d23e3a4cd8e81dca3340b4816029af9c81ab54058168cf4c2293d4cd', 5592, '165c2b24a0371718504d12b21d7f106427406d2c986bdaa5bbe3e1f2d12f6f05'] },
	{ id: 'zh_CN-huayan-medium', label: 'Huayan · Chinese (Mandarin) · medium', language: 'zh_CN', path: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx', files: [63201294, 'b6574ffd0b3382fb05b74bab4308c38eb6ab5b485dde950a50a2cdb95eec5c49', 4822, 'ff5334dfac1b30624d1568ec21bbb50bf4dd6d232c14e238897ac538e1325a18'] },
	{ id: 'zh_CN-huayan-x_low', label: 'Huayan · Chinese (Mandarin) · extra-low', language: 'zh_CN', path: 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx', files: [20628813, '875406fb0695bb91cd617970a3d264f8a0fb120221c672a7ba736e92f8832545', 4164, 'bae90c0e5ea5e74eeded71b343f7f6cc8116184b376b1d0af4e4a3fb7231bef1'] }
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

const voiceModels = new Map<string, ModelDef>();
/** Browser-store model for one voice's two files (.onnx + .onnx.json). */
export function piperVoiceModel(voiceId: string): ModelDef {
	let model = voiceModels.get(voiceId);
	if (!model) {
		const voice = piperVoice(voiceId);
		const [onnxBytes, onnxBlake3, configBytes, configBlake3] = voice.files;
		model = {
			id: `speech:piper-${voice.id}`,
			task: 'text-to-speech',
			label: `Piper · ${voice.label}`,
			license: 'MIT',
			files: [
				{ path: voice.path, bytes: onnxBytes, blake3: onnxBlake3, url: piperFileUrl(voice.path) },
				{ path: piperConfigPath(voice), bytes: configBytes, blake3: configBlake3, url: piperFileUrl(piperConfigPath(voice)) }
			],
			origin: { kind: 'hf', repo: PIPER_HF_REPO, revision: PIPER_HF_REVISION }
		};
		voiceModels.set(voiceId, model);
	}
	return model;
}
