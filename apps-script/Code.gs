/** HACHIHI EVENT CHECK-IN - Google Apps Script bridge
 * Script Properties:
 * WORKER_URL       https://your-worker.workers.dev
 * EVENT_SLUG       event slug, e.g. hoi-nghi-khach-hang-2026
 * INTEGRATION_SECRET  same value as Worker APPS_SCRIPT_SECRET
 * SPREADSHEET_ID   spreadsheet ID (optional when bound to the spreadsheet)
 * CHECKIN_SHEET    default: Checkins
 */
function props_(){ return PropertiesService.getScriptProperties(); }
function cfg_(k, fallback){ return props_().getProperty(k) || fallback || ''; }
function json_(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// Worker -> Apps Script: append check-ins to Google Sheets. Accepts {rows:[...]} (batch, v3) or a single object (v2).
// Idempotent: a check-in_id already present in column A is skipped, so a retry after a lost response never duplicates rows.
function doPost(e){
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!cfg_('INTEGRATION_SECRET') || body.secret !== cfg_('INTEGRATION_SECRET')) return ContentService.createTextOutput('unauthorized');
    var rows = body.rows || [body];
    lock.waitLock(20000);
    var ss = cfg_('SPREADSHEET_ID') ? SpreadsheetApp.openById(cfg_('SPREADSHEET_ID')) : SpreadsheetApp.getActiveSpreadsheet();
    var name = cfg_('CHECKIN_SHEET','Checkins');
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(['Check-in ID','Event slug','Event name','Họ tên','Email','Công ty','Thời gian','Máy','Gmail','Nguồn','Kết quả','Ảnh']);
    var last = sh.getLastRow(), seen = {};
    if (last > 1) sh.getRange(2,1,last-1,1).getValues().forEach(function(r){ if (r[0] !== '') seen[String(r[0])] = 1; });
    var out = [];
    rows.forEach(function(b){
      var id = String(b.checkin_id || '');
      if (id && seen[id]) return;
      if (id) seen[id] = 1;
      out.push([b.checkin_id||'',b.event_slug||'',b.event_name||'',b.full_name||'',b.email||'',b.company||'',b.checkin_time||'',b.machine||'',b.gmail||'',b.source||'',b.result||'success',b.photo_url||'']);
    });
    if (out.length) sh.getRange(sh.getLastRow()+1,1,out.length,12).setValues(out);
    return ContentService.createTextOutput('ok ' + out.length + '/' + rows.length);
  } catch(err){ return ContentService.createTextOutput('error: '+err.message); }
  finally { try { lock.releaseLock(); } catch(x){} }
}

// Google Forms bridge (unchanged): Form submit -> Worker /api/integrations/attendee.
function onFormSubmit(e){
  var nv = (e && e.namedValues) || {};
  var get = function(){ for(var i=0;i<arguments.length;i++){var v=nv[arguments[i]];if(v&&v.length)return String(v[0]).trim();}return ''; };
  var name=get('Họ và tên','Họ tên','Full name','Name');
  var email=get('Email','Địa chỉ email');
  if(!name) throw new Error('Không tìm thấy cột Họ và tên trong Google Form');
  var photoUrl=get('Ảnh chân dung','Ảnh đại diện','Photo');
  var fileId=driveFileId_(photoUrl), photoBase64='', photoMime='image/jpeg';
  if(fileId){
    var file=DriveApp.getFileById(fileId), blob=file.getBlob();
    photoMime=blob.getContentType() || 'image/jpeg';
    photoBase64=Utilities.base64Encode(blob.getBytes());
  }
  var payload={event_slug:cfg_('EVENT_SLUG'),full_name:name,email:email,phone:get('Số điện thoại','Điện thoại','Phone'),company:get('Công ty','Company'),position:get('Chức danh','Position'),attendee_code:get('Mã khách','Mã đăng ký','EmployeeCode'),photo_base64:photoBase64,photo_mime:photoMime};
  var url=cfg_('WORKER_URL')+'/api/integrations/attendee';
  var res=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{'x-integration-secret':cfg_('INTEGRATION_SECRET')},payload:JSON.stringify(payload),muteHttpExceptions:true});
  if(res.getResponseCode()<200||res.getResponseCode()>=300) throw new Error('Worker '+res.getResponseCode()+': '+res.getContentText());
}
function driveFileId_(url){
  var s=String(url||'');
  var m=s.match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

// Run once from Apps Script editor to create the installable trigger.
function installFormSubmitTrigger(){
  var ss=cfg_('SPREADSHEET_ID') ? SpreadsheetApp.openById(cfg_('SPREADSHEET_ID')) : SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='onFormSubmit';}).forEach(function(t){ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
}
