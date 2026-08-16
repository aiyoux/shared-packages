//! Browser WASM bindings for VTracer 1.0.
//!
//! Same options surface as `@visioncortex/vtracer` (Node), but compiled for
//! `wasm32-unknown-unknown` so the hub can call `vectorize_rgba` in a Worker.

use serde::Deserialize;
use vtracer::{Color, ColorImage, Config};
use wasm_bindgen::prelude::*;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
	clustering: Option<String>,
	hierarchical: Option<String>,
	mode: Option<String>,
	filter_speckle: Option<usize>,
	color_precision: Option<i32>,
	layer_difference: Option<i32>,
	corner_threshold: Option<i32>,
	length_threshold: Option<f64>,
	max_iterations: Option<usize>,
	splice_threshold: Option<i32>,
	simplify: Option<f64>,
	path_precision: Option<u32>,
	palette: Option<Vec<String>>,
	max_colors: Option<usize>,
	optimize: Option<u8>,
	binary_threshold: Option<u8>,
	adaptive: Option<bool>,
	adaptive_window: Option<u32>,
	adaptive_t: Option<f64>,
	watershed_detail: Option<u32>,
	preset: Option<String>,
}

fn err(msg: impl std::fmt::Display) -> JsValue {
	JsValue::from_str(&msg.to_string())
}

fn parse_hex(token: &str) -> Result<Color, JsValue> {
	let hex = token.strip_prefix('#').unwrap_or(token);
	if hex.len() != 6 {
		return Err(err(format!("`{token}` is not a #rrggbb color")));
	}
	let b = |r: std::ops::Range<usize>| {
		u8::from_str_radix(&hex[r], 16).map_err(|_| err(format!("`{token}` is not a #rrggbb color")))
	};
	Ok(Color::new(b(0..2)?, b(2..4)?, b(4..6)?))
}

fn config_from(options: JsValue) -> Result<Config, JsValue> {
	let opts: Options = if options.is_undefined() || options.is_null() {
		Options::default()
	} else {
		serde_wasm_bindgen::from_value(options).map_err(err)?
	};

	let mut config = match opts.preset.as_deref() {
		Some("bw") => Config::from_preset(vtracer::Preset::Bw),
		Some("poster") => Config::from_preset(vtracer::Preset::Poster),
		Some("photo") => Config::from_preset(vtracer::Preset::Photo),
		Some(other) => return Err(err(format!("unknown preset `{other}`"))),
		None => Config::default(),
	};

	if let Some(v) = opts.clustering {
		config.clustering = v.parse().map_err(err)?;
	}
	if let Some(v) = opts.hierarchical {
		config.hierarchical = v.parse().map_err(err)?;
	}
	if let Some(v) = opts.mode {
		config.mode = v.parse().map_err(err)?;
	}
	if let Some(v) = opts.filter_speckle {
		config.filter_speckle = v;
	}
	if let Some(v) = opts.color_precision {
		config.color_precision = v;
	}
	if let Some(v) = opts.layer_difference {
		config.layer_difference = v;
	}
	if let Some(v) = opts.corner_threshold {
		config.corner_threshold = v;
	}
	if let Some(v) = opts.length_threshold {
		config.length_threshold = v;
	}
	if let Some(v) = opts.max_iterations {
		config.max_iterations = v;
	}
	if let Some(v) = opts.splice_threshold {
		config.splice_threshold = v;
	}
	if let Some(v) = opts.simplify {
		config.simplify = if v > 0.0 { Some(v) } else { None };
	}
	if let Some(v) = opts.path_precision {
		config.path_precision = Some(v);
	}
	if let Some(list) = opts.palette {
		config.palette = list.iter().map(|s| parse_hex(s)).collect::<Result<_, _>>()?;
	}
	if let Some(v) = opts.max_colors {
		config.max_colors = if v > 0 { Some(v) } else { None };
	}
	if let Some(v) = opts.optimize {
		config.optimize = v;
	}
	if let Some(v) = opts.binary_threshold {
		config.binary_threshold = v;
	}
	if opts.adaptive == Some(true) || opts.adaptive_window.is_some() || opts.adaptive_t.is_some() {
		config.binary_adaptive = true;
	}
	if opts.adaptive == Some(false) {
		config.binary_adaptive = false;
	}
	if let Some(v) = opts.adaptive_window {
		config.binary_adaptive_window = v;
	}
	if let Some(v) = opts.adaptive_t {
		config.binary_adaptive_t = v;
	}
	if let Some(v) = opts.watershed_detail {
		config.watershed_detail = v.min(255) as u8;
	}
	Ok(config)
}

/// Vectorize a raw RGBA8 buffer (`width * height * 4` bytes). Returns SVG.
#[wasm_bindgen]
pub fn vectorize_rgba(
	data: Vec<u8>,
	width: usize,
	height: usize,
	options: JsValue,
) -> Result<String, JsValue> {
	if data.len() != width * height * 4 {
		return Err(err(format!(
			"rgba length {} != width*height*4 ({})",
			data.len(),
			width * height * 4
		)));
	}
	let config = config_from(options)?;
	config
		.build()
		.map_err(err)?
		.to_svg(&ColorImage {
			pixels: data,
			width,
			height,
		})
		.map_err(err)
}
