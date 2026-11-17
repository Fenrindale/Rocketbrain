'use strict';

// Reviewed scalar adapters. UTC is the only timestamp policy; execution must
// independently verify the owned server session before observing/copying rows.
const STRATEGIES=['text-year','number-year','year-text','year-number','hex-decode','hex-encode','base64-decode','base64-encode','text-timestamp-utc','calendar-timestamp-utc','timestamp-calendar-utc','timestamp-text-utc'];
const UTC_STRATEGIES=STRATEGIES.filter(value=>value.endsWith('-utc'));
const EFFECTS={
 'text-year':'Require four year digits: 0000 or 1901 through 2155; never infer a two-digit century.',
 'number-year':'Require exact integer 0 or 1901 through 2155; zero remains the YEAR zero sentinel.',
 'year-text':'Render exactly four year digits, preserving 0000 separately from SQL NULL.',
 'year-number':'Render YEAR as the integer 0 or its full four-digit year.',
 'hex-decode':'Decode even-length hexadecimal digits without a prefix; reject invalid bytes, whitespace and truncation.',
 'hex-encode':'Render every source byte as two uppercase hexadecimal digits, without a prefix.',
 'base64-decode':'Decode canonical padded RFC 4648 base64; reject whitespace, URL alphabet, missing padding and nonzero pad bits.',
 'base64-encode':'Render every source byte as canonical padded base64 without line breaks.',
 'text-timestamp-utc':'Parse an explicit ISO UTC Z literal into TIMESTAMP under a verified UTC session; no locale, DST or offset inference.',
 'calendar-timestamp-utc':'Interpret DATE/DATETIME as explicitly reviewed UTC wall time and store the exact instant in TIMESTAMP.',
 'timestamp-calendar-utc':'Observe TIMESTAMP in verified UTC and preserve that UTC calendar value; DATE requires midnight.',
 'timestamp-text-utc':'Render TIMESTAMP as ISO UTC Z text with its declared fractional precision.'
};
const error=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_CONVERSION'});
function year(value,textOnly=false){
 const text=typeof value==='number'&&Number.isInteger(value)?String(value):typeof value==='bigint'?String(value):value;
 if(typeof text!=='string'||!(textOnly?/^\d{4}$/:/^(?:0|\d{4})$/).test(text))throw error('YEAR requires four digits or an exact observed numeric zero; two-digit century inference is refused.');
 const number=Number(text);if(number!==0&&(number<1901||number>2155))throw error('YEAR is limited to the zero sentinel 0000 or 1901 through 2155.');
 return String(number).padStart(4,'0');
}
function allowed(strategy,from,to){switch(strategy){
 case'text-year':return from.category==='text'&&to.category==='year';
 case'number-year':return from.kind==='integer'&&to.category==='year';
 case'year-text':return from.category==='year'&&to.category==='text';
 case'year-number':return from.category==='year'&&to.kind==='integer';
 case'hex-decode':case'base64-decode':return from.category==='text'&&to.category==='binary';
 case'hex-encode':case'base64-encode':return from.category==='binary'&&to.category==='text';
 case'text-timestamp-utc':return from.category==='text'&&to.category==='TIMESTAMP';
 case'calendar-timestamp-utc':return ['DATE','DATETIME'].includes(from.category)&&to.category==='TIMESTAMP';
 case'timestamp-calendar-utc':return from.category==='TIMESTAMP'&&['DATE','DATETIME'].includes(to.category);
 case'timestamp-text-utc':return from.category==='TIMESTAMP'&&to.category==='text';
 default:return false;
}}
function validateRule(rule){if(UTC_STRATEGIES.includes(rule.strategy)){if(rule.timezone!=='UTC')throw error('Timestamp conversion requires the explicit timezone UTC policy.');}else if(rule.timezone!==undefined)throw error('Only reviewed UTC timestamp strategies accept a timezone policy.');}
function timestamp(value,target,calendar){const result=calendar(value,target),padded=result.includes('.')?result.padEnd(26,'0'):result+'.000000';if(padded<'1970-01-01 00:00:01.000000'||padded>'2038-01-19 03:14:07.499999')throw error('UTC TIMESTAMP is outside the supported shared 1970 through 2038 range.');return result;}
function convert(value,d,base){const {stringValue,binary,calendar,canonicalValue}=base;let result;switch(d.strategy){
 case'text-year':result=year(stringValue(value),true);break;
 case'number-year':result=year(canonicalValue(value,d.from));break;
 case'year-text':result=year(value);break;
 case'year-number':result=String(Number(year(value)));break;
 case'hex-decode':{const text=stringValue(value);if(!/^(?:[0-9a-fA-F]{2})*$/.test(text))throw error('Hex requires even-length hexadecimal digits without a prefix or whitespace.');result=Buffer.from(text,'hex');break;}
 case'hex-encode':result=binary(value).toString('hex').toUpperCase();break;
 case'base64-decode':{const text=stringValue(value);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw error('Use canonical padded base64 without whitespace or a URL alphabet.');result=Buffer.from(text,'base64');if(result.toString('base64')!==text)throw error('Base64 contains noncanonical padding bits.');break;}
 case'base64-encode':result=binary(value).toString('base64');break;
 case'text-timestamp-utc':{const text=stringValue(value);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(text))throw error('Use an explicit ISO UTC timestamp with T and terminal Z; offsets and timezone inference are refused.');result=timestamp(text.slice(0,-1).replace('T',' '),d.to,calendar);break;}
 case'calendar-timestamp-utc':result=timestamp(value,d.to,calendar);break;
 case'timestamp-calendar-utc':{const observed=timestamp(value,d.from,calendar);result=calendar(observed,d.to);break;}
 case'timestamp-text-utc':{const observed=timestamp(value,d.from,calendar),parts=observed.split('.');result=parts[0].replace(' ','T')+(d.from.scale?'.'+(parts[1]||'').padEnd(d.from.scale,'0'):'')+'Z';break;}
 default:throw error('Unsupported extended conversion strategy.');
 }canonicalValue(result,d.to);return result;
}
function expression(d,source){switch(d.strategy){
 case'text-year':case'number-year':case'year-number':return 'CAST('+source+' AS UNSIGNED)';
 case'year-text':return "LPAD(CAST(CAST("+source+" AS UNSIGNED) AS CHAR CHARACTER SET utf8mb4),4,'0')";
 case'hex-decode':return 'UNHEX('+source+')';
 case'hex-encode':return 'HEX('+source+')';
 case'base64-decode':return 'FROM_BASE64('+source+')';
 case'base64-encode':return "REPLACE(REPLACE(TO_BASE64("+source+"),CHAR(10),''),CHAR(13),'')";
 case'text-timestamp-utc':return "CAST(REPLACE(LEFT("+source+",CHAR_LENGTH("+source+")-1),'T',' ') AS DATETIME("+d.to.scale+"))";
 case'calendar-timestamp-utc':return source;
 case'timestamp-calendar-utc':return 'CAST('+source+' AS '+d.to.type+')';
 default:throw error('Unsupported extended conversion expression.');
}}
// DATE_FORMAT emits six fractional digits; explicit SUBSTRING gives exactly the
// source column precision without server-side stringification differences.
function sqlExpression(d,source){if(d.strategy==='timestamp-text-utc'){const whole="DATE_FORMAT("+source+",'%Y-%m-%dT%H:%i:%s')";return d.from.scale?"CONCAT("+whole+",'.',LEFT(DATE_FORMAT("+source+",'%f'),"+d.from.scale+"),'Z')":"CONCAT("+whole+",'Z')";}return expression(d,source);}
module.exports={STRATEGIES,UTC_STRATEGIES,EFFECTS,year,allowed,validateRule,convert,expression:sqlExpression};
