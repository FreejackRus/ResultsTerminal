use std::fmt;

const FULL_PAYLOAD_LEN: usize = 130;
const SIGNATURE_OFFSET: usize = 65;
const MIN_LAB_BARCODE_LEN: usize = 6;
const MAX_LAB_BARCODE_LEN: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OmsInputSource {
    RawPdf417Bytes,
    KeyboardPdf417Text,
    PrintedNumber,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmsScanResult {
    pub source: OmsInputSource,
    pub oms_number: String,
    pub payload_type: Option<u8>,
    pub raw_len: Option<usize>,
    pub raw_hex: Option<String>,
    pub payload_hex: Option<String>,
    pub last_name: Option<String>,
    pub first_name: Option<String>,
    pub middle_name: Option<String>,
    pub date_of_birth: Option<String>,
    pub expires_at: Option<String>,
    pub gender: Option<u8>,
    pub gender_label: Option<String>,
    pub signature_hex: Option<String>,
    pub ogrn: Option<String>,
    pub okato: Option<String>,
    pub checksum_valid: Option<bool>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerScanKind {
    Oms,
    LabBarcode,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabBarcodeResult {
    pub value: String,
    pub raw_len: usize,
    pub raw_hex: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownScanResult {
    pub raw_len: usize,
    pub raw_hex: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannerScanResult {
    Oms(OmsScanResult),
    LabBarcode(LabBarcodeResult),
    Unknown(UnknownScanResult),
}

impl ScannerScanResult {
    pub fn kind(&self) -> ScannerScanKind {
        match self {
            ScannerScanResult::Oms(_) => ScannerScanKind::Oms,
            ScannerScanResult::LabBarcode(_) => ScannerScanKind::LabBarcode,
            ScannerScanResult::Unknown(_) => ScannerScanKind::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OmsParseError {
    PayloadTooShort { len: usize },
    TextContainsNonLatin1 { ch: char },
    InvalidPrintedNumber { value: String },
    InvalidLabBarcode { value: String },
}

impl fmt::Display for OmsParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OmsParseError::PayloadTooShort { len } => {
                write!(
                    f,
                    "PDF417 payload is too short: expected at least 9 bytes, got {len}"
                )
            }
            OmsParseError::TextContainsNonLatin1 { ch } => {
                write!(
                    f,
                    "scanner text contains a non Latin-1 character: U+{:04X}",
                    *ch as u32
                )
            }
            OmsParseError::InvalidPrintedNumber { value } => {
                write!(f, "invalid printed OMS number: {value:?}")
            }
            OmsParseError::InvalidLabBarcode { value } => {
                write!(f, "invalid lab barcode: {value:?}")
            }
        }
    }
}

impl std::error::Error for OmsParseError {}

pub fn classify_scanner_frame(raw: &[u8]) -> ScannerScanResult {
    if let Some(digits) = ascii_digits_scan_value(raw) {
        if digits.len() == 16 {
            return match parse_printed_number(&digits) {
                Ok(result) => ScannerScanResult::Oms(result),
                Err(error) => unknown_scan_result(raw, error.to_string()),
            };
        }

        if is_lab_barcode_value(&digits) {
            return ScannerScanResult::LabBarcode(LabBarcodeResult {
                value: digits,
                raw_len: raw.len(),
                raw_hex: bytes_to_hex(raw),
                warnings: Vec::new(),
            });
        }

        return unknown_scan_result(
            raw,
            format!(
                "numeric scanner value has unsupported length {}; expected 6..12 for lab barcode or 16 for OMS number",
                digits.len()
            ),
        );
    }

    if looks_like_oms_payload(raw) {
        return match parse_pdf417_payload(raw) {
            Ok(result) => ScannerScanResult::Oms(result),
            Err(error) => unknown_scan_result(raw, error.to_string()),
        };
    }

    unknown_scan_result(
        raw,
        "scanner frame is neither ASCII digits nor OMS PDF417 payload".to_string(),
    )
}

pub fn parse_pdf417_payload(raw: &[u8]) -> Result<OmsScanResult, OmsParseError> {
    if raw.len() < 9 {
        return Err(OmsParseError::PayloadTooShort { len: raw.len() });
    }

    let mut warnings = Vec::new();
    let full_payload = first_full_payload(raw, &mut warnings);
    let number_source = full_payload.unwrap_or(raw);

    let payload_type = number_source[0];
    let oms_number = parse_oms_number(number_source);
    let mut result = empty_scan_result(
        OmsInputSource::RawPdf417Bytes,
        oms_number,
        Some(payload_type),
        warnings,
    );
    result.raw_len = Some(raw.len());
    result.raw_hex = Some(bytes_to_hex(raw));

    if let Some(payload) = full_payload {
        result.payload_hex = Some(bytes_to_hex(payload));
        let decode_warnings = decode_full_payload(payload, &mut result);
        result.warnings.extend(decode_warnings);
    }

    Ok(result)
}

pub fn parse_keyboard_wedge_text(text: &str) -> Result<OmsScanResult, OmsParseError> {
    if let Ok(result) = parse_printed_number(text) {
        return Ok(result);
    }

    let raw = latin1_text_to_bytes(trim_scan_terminators(text))?;
    let mut result = parse_pdf417_payload(&raw)?;
    result.source = OmsInputSource::KeyboardPdf417Text;
    result.warnings.push(
        "keyboard wedge preserved PDF417 bytes as Latin-1 text; prefer raw serial/HID bytes if available"
            .to_string(),
    );
    Ok(result)
}

pub fn parse_printed_number(text: &str) -> Result<OmsScanResult, OmsParseError> {
    let value = text
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect::<String>();

    if value.len() != 16 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(OmsParseError::InvalidPrintedNumber { value });
    }

    Ok(empty_scan_result(
        OmsInputSource::PrintedNumber,
        value,
        None,
        vec![
            "scanner returned only the printed number; PDF417 payload bytes are unavailable"
                .to_string(),
        ],
    ))
}

pub fn parse_lab_barcode(text: &str) -> Result<LabBarcodeResult, OmsParseError> {
    let value = text
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect::<String>();

    if !is_lab_barcode_value(&value) {
        return Err(OmsParseError::InvalidLabBarcode { value });
    }

    Ok(LabBarcodeResult {
        raw_len: text.len(),
        raw_hex: bytes_to_hex(text.as_bytes()),
        value,
        warnings: Vec::new(),
    })
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn empty_scan_result(
    source: OmsInputSource,
    oms_number: String,
    payload_type: Option<u8>,
    warnings: Vec<String>,
) -> OmsScanResult {
    OmsScanResult {
        source,
        oms_number,
        payload_type,
        raw_len: None,
        raw_hex: None,
        payload_hex: None,
        last_name: None,
        first_name: None,
        middle_name: None,
        date_of_birth: None,
        expires_at: None,
        gender: None,
        gender_label: None,
        signature_hex: None,
        ogrn: None,
        okato: None,
        checksum_valid: None,
        warnings,
    }
}

fn parse_oms_number(raw: &[u8]) -> String {
    let mut number_bytes = [0u8; 8];
    number_bytes.copy_from_slice(&raw[1..9]);
    u64::from_be_bytes(number_bytes).to_string()
}

fn first_full_payload<'a>(raw: &'a [u8], warnings: &mut Vec<String>) -> Option<&'a [u8]> {
    if raw.len() < FULL_PAYLOAD_LEN {
        return None;
    }

    if is_supported_payload_type(raw[0]) {
        if raw.len() > FULL_PAYLOAD_LEN {
            warnings.push(extra_payload_bytes_warning(raw));
        }
        return Some(&raw[..FULL_PAYLOAD_LEN]);
    }

    for offset in 1..=raw.len() - FULL_PAYLOAD_LEN {
        if is_supported_payload_type(raw[offset]) {
            warnings.push(format!(
                "using OMS payload at byte offset {offset}; ignored surrounding bytes"
            ));
            return Some(&raw[offset..offset + FULL_PAYLOAD_LEN]);
        }
    }

    None
}

fn extra_payload_bytes_warning(raw: &[u8]) -> String {
    let duplicated_frame_len = FULL_PAYLOAD_LEN + 1 + FULL_PAYLOAD_LEN + 1;
    let second_start = FULL_PAYLOAD_LEN + 1;

    if raw.len() == duplicated_frame_len
        && raw[FULL_PAYLOAD_LEN] == b'\r'
        && raw[second_start + FULL_PAYLOAD_LEN] == b'\r'
        && raw[..FULL_PAYLOAD_LEN] == raw[second_start..second_start + FULL_PAYLOAD_LEN]
    {
        return "input contains the same 130-byte OMS payload twice separated by CR; decoded the first frame"
            .to_string();
    }

    if raw.len() == FULL_PAYLOAD_LEN + 1 && raw[FULL_PAYLOAD_LEN] == b'\r' {
        return "input contains a trailing CR after the 130-byte OMS payload; decoded without the terminator"
            .to_string();
    }

    format!(
        "input contains {} extra byte(s) after the first 130-byte OMS payload; decoded the first frame",
        raw.len() - FULL_PAYLOAD_LEN
    )
}

fn is_supported_payload_type(value: u8) -> bool {
    matches!(value, 1 | 2)
}

fn looks_like_oms_payload(raw: &[u8]) -> bool {
    if raw.len() < 9 {
        return false;
    }

    if is_supported_payload_type(raw[0]) {
        return true;
    }

    raw.len() >= FULL_PAYLOAD_LEN
        && raw
            .windows(FULL_PAYLOAD_LEN)
            .any(|window| is_supported_payload_type(window[0]))
}

fn ascii_digits_scan_value(raw: &[u8]) -> Option<String> {
    let trimmed = trim_ascii_scan_terminators(raw);

    if trimmed.is_empty() || !trimmed.iter().all(u8::is_ascii_digit) {
        return None;
    }

    String::from_utf8(trimmed.to_vec()).ok()
}

fn trim_ascii_scan_terminators(raw: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = raw.len();

    while start < end && raw[start].is_ascii_whitespace() {
        start += 1;
    }

    while end > start && raw[end - 1].is_ascii_whitespace() {
        end -= 1;
    }

    &raw[start..end]
}

fn is_lab_barcode_value(value: &str) -> bool {
    (MIN_LAB_BARCODE_LEN..=MAX_LAB_BARCODE_LEN).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn unknown_scan_result(raw: &[u8], reason: String) -> ScannerScanResult {
    ScannerScanResult::Unknown(UnknownScanResult {
        raw_len: raw.len(),
        raw_hex: bytes_to_hex(raw),
        reason,
    })
}

fn decode_full_payload(payload: &[u8], result: &mut OmsScanResult) -> Vec<String> {
    let mut warnings = Vec::new();

    if payload.len() != FULL_PAYLOAD_LEN {
        warnings.push(format!(
            "full OMS payload decoder expects 130 bytes, got {}",
            payload.len()
        ));
        return warnings;
    }

    result.signature_hex = Some(bytes_to_hex(&payload[SIGNATURE_OFFSET..]));
    result.checksum_valid = Some(is_luhn_valid(&result.oms_number));

    let decoded = match payload[0] {
        1 => decode_type1_payload(payload, result),
        2 => decode_type2_payload(payload, result),
        value => Err(format!("unsupported OMS payload type {value}")),
    };

    if let Err(warning) = decoded {
        warnings.push(warning);
    }

    warnings
}

fn decode_type1_payload(payload: &[u8], result: &mut OmsScanResult) -> Result<(), String> {
    let mut encoded_fio = payload[9..42].to_vec();
    encoded_fio.reverse();

    let fio_text = decode_oms_text(&encoded_fio).trim().to_string();
    let parts = split_fio_parts(&fio_text)?;
    result.middle_name = Some(reverse_string(&parts[0]));
    result.last_name = Some(reverse_string(&parts[1]));
    result.first_name = Some(reverse_string(&parts[2]));

    result.gender = Some(payload[51]);
    result.gender_label = gender_label(payload[51]).map(str::to_string);
    result.date_of_birth = Some(decode_oms_date(&payload[52..54]));
    result.expires_at = Some(decode_oms_date(&payload[54..56]));
    result.ogrn = Some(read_be_uint(&payload[56..62]).to_string());
    result.okato = Some(read_be_uint(&payload[62..65]).to_string());

    Ok(())
}

fn decode_type2_payload(payload: &[u8], result: &mut OmsScanResult) -> Result<(), String> {
    let fio_block_end = find_fio_block_end(9, payload)
        .ok_or_else(|| "could not locate FIO/date marker in type 2 OMS payload".to_string())?;
    let fio_payload_end = fio_block_end
        .checked_sub(8)
        .filter(|end| *end >= 9)
        .ok_or_else(|| "invalid FIO block boundary in type 2 OMS payload".to_string())?;

    if fio_block_end + 6 > SIGNATURE_OFFSET {
        return Err("invalid date/gender boundary in type 2 OMS payload".to_string());
    }

    let fio_text = decode_oms_text(&payload[9..fio_payload_end])
        .trim()
        .to_string();
    let parts = split_fio_parts(&fio_text)?;
    result.last_name = Some(parts[0].clone());
    result.first_name = Some(parts[1].clone());
    result.middle_name = Some(parts[2].clone());

    let gender = payload[fio_block_end + 1];
    result.gender = Some(gender);
    result.gender_label = gender_label(gender).map(str::to_string);
    result.date_of_birth = Some(decode_oms_date(
        &payload[fio_block_end + 2..fio_block_end + 4],
    ));
    result.expires_at = Some(decode_oms_date(
        &payload[fio_block_end + 4..fio_block_end + 6],
    ));
    result.ogrn = None;
    result.okato = None;

    Ok(())
}

fn split_fio_parts(value: &str) -> Result<Vec<String>, String> {
    let parts = value.split('|').map(str::to_string).collect::<Vec<_>>();
    if parts.len() < 3 {
        return Err(format!(
            "invalid FIO block: expected 3 parts, got {}",
            parts.len()
        ));
    }
    Ok(parts)
}

fn find_fio_block_end(start: usize, data: &[u8]) -> Option<usize> {
    let mut index = start;
    while index + 2 < data.len() {
        if data[index] == 0 && data[index + 1] == 0 && matches!(data[index + 2], 1 | 2) {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

fn decode_oms_text(encoded: &[u8]) -> String {
    const OMS_CHARS: [char; 64] = [
        ' ', '.', '-', '\u{2018}', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '\u{0410}',
        '\u{0411}', '\u{0412}', '\u{0413}', '\u{0414}', '\u{0415}', '\u{0401}', '\u{0416}',
        '\u{0417}', '\u{0418}', '\u{0419}', '\u{041a}', '\u{041b}', '\u{041c}', '\u{041d}',
        '\u{041e}', '\u{041f}', '\u{0420}', '\u{0421}', '\u{0422}', '\u{0423}', '\u{0424}',
        '\u{0425}', '\u{0426}', '\u{0427}', '\u{0428}', '\u{0429}', '\u{042c}', '\u{042a}',
        '\u{042b}', '\u{042d}', '\u{042e}', '\u{042f}', '*', '*', '*', '*', '*', '*', '*', '*',
        '*', '*', '*', '*', '*', '*', '*', '*', '|',
    ];

    let mut accumulator = 0u32;
    let mut bits_collected = 0u8;
    let mut decoded = String::new();

    for byte in encoded {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits_collected += 8;

        while bits_collected >= 6 {
            let index = ((accumulator >> (bits_collected - 6)) & 0x3f) as usize;
            decoded.push(OMS_CHARS[index]);
            bits_collected -= 6;
            accumulator &= if bits_collected == 0 {
                0
            } else {
                (1 << bits_collected) - 1
            };
        }
    }

    if bits_collected > 0 {
        let index = ((accumulator << (6 - bits_collected)) & 0x3f) as usize;
        decoded.push(OMS_CHARS[index]);
    }

    decoded
}

fn decode_oms_date(bytes: &[u8]) -> String {
    let mut remaining_days = u16::from_be_bytes([bytes[0], bytes[1]]) as i32;
    let mut year = 1900;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }

    let days_by_month = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for days_in_month in days_by_month {
        if remaining_days < days_in_month {
            break;
        }
        remaining_days -= days_in_month;
        month += 1;
    }

    format!("{year:04}-{month:02}-{:02}", remaining_days + 1)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn read_be_uint(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte))
}

fn reverse_string(value: &str) -> String {
    value.chars().rev().collect()
}

fn gender_label(value: u8) -> Option<&'static str> {
    match value {
        1 => Some("male"),
        2 => Some("female"),
        _ => None,
    }
}

fn is_luhn_valid(value: &str) -> bool {
    if value.len() != 16 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }

    match calculate_luhn_check_digit(&value[..15]) {
        Some(check_digit) => value.as_bytes()[15] == check_digit,
        None => false,
    }
}

fn calculate_luhn_check_digit(value: &str) -> Option<u8> {
    let mut sum = 0u32;

    for (index, byte) in value.as_bytes().iter().rev().enumerate() {
        if !byte.is_ascii_digit() {
            return None;
        }

        let digit = u32::from(byte - b'0');
        sum += if index % 2 == 1 {
            digit
        } else if digit == 0 {
            0
        } else {
            let doubled_mod = (digit * 2) % 9;
            if doubled_mod == 0 {
                9
            } else {
                doubled_mod
            }
        };
    }

    Some(b'0' + ((10 - sum % 10) % 10) as u8)
}

fn latin1_text_to_bytes(text: &str) -> Result<Vec<u8>, OmsParseError> {
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        if code > 0xff {
            return Err(OmsParseError::TextContainsNonLatin1 { ch });
        }
        bytes.push(code as u8);
    }
    Ok(bytes)
}

fn trim_scan_terminators(text: &str) -> &str {
    text.trim_matches(|ch| matches!(ch, '\r' | '\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> Vec<u8> {
        let mut raw = vec![0x02, 0x00, 0x12, 0x14, 0x3c, 0x84, 0xb7, 0x74, 0xba];
        raw.extend([0x10, 0x20, 0x30, 0x40]);
        raw
    }

    fn scanned_type2_payload() -> Vec<u8> {
        hex_to_bytes(
            "02001161f9b5be9c3241d7dd71d43f41a3925db5dffd26d785f5d34179800000000000000000000000000000000000000000000000000000000000000192500000813ba7879a9a491190f390944bc88fe3cf8d52f767aa0db0d20f67605c4a57e5a0f41e7b676cf766f20f9200c82f8f7c05fb73ce91aacd0ea363ad2d2c09966328",
        )
    }

    fn hex_to_bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|chunk| {
                let text = std::str::from_utf8(chunk).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    #[test]
    fn parses_raw_pdf417_payload() {
        let result = parse_pdf417_payload(&sample_payload()).unwrap();

        assert_eq!(result.source, OmsInputSource::RawPdf417Bytes);
        assert_eq!(result.payload_type, Some(2));
        assert_eq!(result.oms_number, "5088799738000570");
        assert_eq!(result.raw_len, Some(13));
        assert_eq!(
            result.raw_hex.as_deref(),
            Some("020012143c84b774ba10203040")
        );
        assert_eq!(result.last_name, None);
    }

    #[test]
    fn parses_full_type2_pdf417_payload() {
        let result = parse_pdf417_payload(&scanned_type2_payload()).unwrap();

        assert_eq!(result.payload_type, Some(2));
        assert_eq!(result.oms_number, "4892799728000050");
        assert_eq!(
            result.last_name.as_deref(),
            Some("\u{0412}\u{041e}\u{0420}\u{041e}\u{041d}\u{041e}\u{0412}")
        );
        assert_eq!(
            result.first_name.as_deref(),
            Some("\u{0412}\u{041b}\u{0410}\u{0414}\u{0418}\u{041c}\u{0418}\u{0420}")
        );
        assert_eq!(
            result.middle_name.as_deref(),
            Some(
                "\u{0414}\u{041c}\u{0418}\u{0422}\u{0420}\u{0418}\u{0415}\u{0412}\u{0418}\u{0427}"
            )
        );
        assert_eq!(result.date_of_birth.as_deref(), Some("2002-07-21"));
        assert_eq!(result.expires_at.as_deref(), Some("1900-01-01"));
        assert_eq!(result.gender, Some(1));
        assert_eq!(result.gender_label.as_deref(), Some("male"));
        assert_eq!(result.ogrn, None);
        assert_eq!(result.okato, None);
        assert_eq!(result.checksum_valid, Some(true));
        assert!(result
            .signature_hex
            .as_deref()
            .unwrap()
            .starts_with("813ba7879a9a4911"));
    }

    #[test]
    fn parses_first_payload_from_com_frame_with_cr_duplicate() {
        let payload = scanned_type2_payload();
        let mut raw = Vec::new();
        raw.extend(&payload);
        raw.push(b'\r');
        raw.extend(&payload);
        raw.push(b'\r');

        let result = parse_pdf417_payload(&raw).unwrap();
        let expected_payload_hex = bytes_to_hex(&payload);

        assert_eq!(result.raw_len, Some(262));
        assert_eq!(
            result.payload_hex.as_deref(),
            Some(expected_payload_hex.as_str())
        );
        assert_eq!(result.oms_number, "4892799728000050");
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("twice")));
    }

    #[test]
    fn parses_keyboard_text_when_latin1_bytes_are_preserved() {
        let text = sample_payload()
            .into_iter()
            .map(char::from)
            .collect::<String>();

        let result = parse_keyboard_wedge_text(&(text + "\n")).unwrap();

        assert_eq!(result.source, OmsInputSource::KeyboardPdf417Text);
        assert_eq!(result.payload_type, Some(2));
        assert_eq!(result.oms_number, "5088799738000570");
    }

    #[test]
    fn parses_printed_number() {
        let result = parse_printed_number("5088799738000570\r\n").unwrap();

        assert_eq!(result.source, OmsInputSource::PrintedNumber);
        assert_eq!(result.oms_number, "5088799738000570");
        assert_eq!(result.payload_type, None);
        assert_eq!(result.raw_hex, None);
    }

    #[test]
    fn parses_lab_barcode() {
        let result = parse_lab_barcode("29147103\r\n").unwrap();

        assert_eq!(result.value, "29147103");
        assert_eq!(result.raw_len, 10);
        assert_eq!(result.raw_hex, "32393134373130330d0a");
    }

    #[test]
    fn classifier_detects_lab_barcode_from_ascii_digits() {
        let result = classify_scanner_frame(b"29147103\r");

        assert_eq!(result.kind(), ScannerScanKind::LabBarcode);
        match result {
            ScannerScanResult::LabBarcode(barcode) => {
                assert_eq!(barcode.value, "29147103");
                assert_eq!(barcode.raw_len, 9);
            }
            other => panic!("expected lab barcode, got {other:?}"),
        }
    }

    #[test]
    fn classifier_preserves_leading_zero_in_nine_digit_barcode() {
        let result = classify_scanner_frame(b"021127860\r");

        assert_eq!(result.kind(), ScannerScanKind::LabBarcode);
        match result {
            ScannerScanResult::LabBarcode(barcode) => {
                assert_eq!(barcode.value, "021127860");
                assert_eq!(barcode.raw_len, 10);
            }
            other => panic!("expected barcode, got {other:?}"),
        }
    }

    #[test]
    fn classifier_detects_printed_oms_number_from_ascii_digits() {
        let result = classify_scanner_frame(b"5088799738000570\r");

        assert_eq!(result.kind(), ScannerScanKind::Oms);
        match result {
            ScannerScanResult::Oms(oms) => {
                assert_eq!(oms.source, OmsInputSource::PrintedNumber);
                assert_eq!(oms.oms_number, "5088799738000570");
            }
            other => panic!("expected OMS scan, got {other:?}"),
        }
    }

    #[test]
    fn classifier_detects_binary_oms_payload() {
        let result = classify_scanner_frame(&scanned_type2_payload());

        assert_eq!(result.kind(), ScannerScanKind::Oms);
        match result {
            ScannerScanResult::Oms(oms) => {
                assert_eq!(oms.source, OmsInputSource::RawPdf417Bytes);
                assert_eq!(oms.oms_number, "4892799728000050");
                assert_eq!(
                    oms.last_name.as_deref(),
                    Some("\u{0412}\u{041e}\u{0420}\u{041e}\u{041d}\u{041e}\u{0412}")
                );
            }
            other => panic!("expected OMS scan, got {other:?}"),
        }
    }

    #[test]
    fn classifier_rejects_unsupported_numeric_length() {
        let result = classify_scanner_frame(b"12345\r");

        assert_eq!(result.kind(), ScannerScanKind::Unknown);
        match result {
            ScannerScanResult::Unknown(unknown) => {
                assert!(unknown.reason.contains("unsupported length"));
            }
            other => panic!("expected unknown scan, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_printed_number() {
        let error = parse_printed_number("508879973800057").unwrap_err();

        assert!(matches!(error, OmsParseError::InvalidPrintedNumber { .. }));
    }

    #[test]
    fn rejects_invalid_lab_barcode() {
        let error = parse_lab_barcode("5088799738000570").unwrap_err();

        assert!(matches!(error, OmsParseError::InvalidLabBarcode { .. }));
    }
}
