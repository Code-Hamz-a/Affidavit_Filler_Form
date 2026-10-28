# Affidavit Filler

Fills law-firm records and billing affidavits, merges the records or invoices behind them, and saves one PDF ready to upload to ChartSwap. Everything runs in the browser on this computer. No patient data is uploaded anywhere.

## Start
Double-click **Affidavit Filler.html**. It opens in Chrome or Edge and needs no internet.

## Steps
1. **Settings & facilities** (one time only): enter the default custodian name, title, county and state. The facility list comes pre-loaded with 20 facilities.
   - Add more with **+ Add facility**, or paste a whole column from Excel with **Paste a list from Excel…**.
   - A facility with its own custodian or county gets them in that row. Leave a cell blank to use the default.
   - "Name on affidavit" is what gets printed. For "… c/o CareCapital" facilities it drops the "c/o CareCapital" part.
2. **Request PDF**: drop in the law firm's request (letter + affidavit + HIPAA authorization). The tool reads:
   - the patient name, DOB and facility
   - the requested DOS range
   - whether this is a **records** or **billing** affidavit
   - the **authorization / release form** (HIPAA) is only **read**, never written on. If the letter does not give the patient name, DOB or facility, they are taken from the authorization. If the letter and the authorization disagree, you get a warning before the PDF is made.
   - which facility from your list the request is for (it matches "c/o CareCapital", "DBA" and "M.D./P.A." variations)
   - whether it is a **subpoena / Deposition on Written Questions (DWQ)**. Each "Answer: ____" blank is answered from the question above it, even when the question starts on the previous page:
     - name + title, pages, and amounts ($ total, insurance paid, Medicare/Medicaid, patient paid, adjustments, written off, balance, lien)
     - **"Yes"** for business-records foundation questions (custodian, regular course, made at or near the time, served with / received the subpoena, authorized to produce, "Have you complied?", made or caused to be made, trustworthy, examined or treated by the facility, "Please hand the records to the Officer / Notary", …). "…how many pages… have you done as requested?" gets "Yes, 14 pages".
     - **"No"** for "extracted anything from the records", "any further records not provided", "withheld", "destroyed or missing", "any other locations where records are kept", "are you aware of any other hospital / physician with records", and "is it your responsibility to manage accounts receivable". "Please describe what you have NOT provided" gets "Not applicable".
     - Standard custodian wording: "Have you now provided all the records…" and "…produced records other than those made the basis of this suit" get "I have provided all medical records under my care and possession." "Are you aware of any other hospital / physician that may have records?" gets "I do not have that information, I am the custodian of records, I maintain and produce medical records." "In the event that no records can be found, are there archives…?" gets "Archive". (Billing subpoenas say "billing records".)
     - **Your own wording is remembered:** if you change a standard answer (Yes / No / Not applicable / retention / "no information"), for example "Yes" → "No, uploaded in ChartSwap", the same question gets your answer on the next subpoena. Typing the standard answer again forgets it. Amounts, dates, page counts and names are never remembered. The custodian's name is never stored either: if your answer contains it, the current custodian's name is used next time.
     - An **Affidavit / Certificate of No Records** is only for when nothing was found, so its blanks start unticked. Tick them in step 4 if there really are no records.
     - "Has your facility been paid?" and "…been paid by private insurance or anyone other than the patient?" are answered Yes / No from the payments. "Total amount still owed **and by whom**" gets the balance and the patient name.
     - Questions about the provider's managed care / contractual arrangements, insurance terms, or "the preceding questions" are case-specific (red the first time, then remembered).
     - case-specific questions (insurance on file, collections, guarantor, letter of protection, …) are shown red the first time. Whatever you type is **remembered** and filled in automatically on the next subpoena with the same question. Patient and facility names are swapped in automatically.
     - "are the charges reasonable / services necessary?" and "how long are records kept?" are answered from **Standard subpoena answers** in Settings. "Full name, occupation and title" also gets the business address.
     - **Scanned subpoenas** (lines only in the image, e.g. Lexitas): answers go after each "Answer:", and the notary blanks (personally appeared, day, month, year, county, state) go into the gaps on the notary lines.
     - blanks for the process server (Officer's Return, Return of Service) and the attorney (Attorney Certification) are skipped.
   - Invoices: UB-04 and CMS-1500 (HCFA) claims are read one by one (DOS, total, paid, patient name, DOB) and merged in DOS order.
   - For billing subpoenas, open **Payment details** in step 3 to enter the payment breakdown.
   - **Scanned PDFs** (only a picture, for example from a Canon scanner) are read with the built-in OCR. This takes about 4 seconds per page, and progress is shown. It works offline too. Check the values afterwards, because OCR can misread a word.
3. **Case details**: check the values. Any required field that is empty turns red, and the PDF can't be created until it is filled in (patient, DOB, facility, DOS).
4. **Records / invoices**: drop in all the files (Part 1, Part 2, …).
   - Records: the page count is filled in automatically.
   - Billing: each UB-04 claim is read separately. UB-04s where only the typed values are text and the red form is a picture are recognised too. A total printed without a decimal point ("525000") is read as $5,250.00, because the form's dotted line splits off the cents. The first DOS, last DOS and total charges come from the invoices. The DOB is taken from the UB-04 if the letter doesn't include it. The invoices are merged in DOS order.
   - **CareCapital cover letters** ("CareCapital & Record Service purchased and is the rightful owner…") are taken out automatically. Only the invoices and records themselves are merged.
   - Some invoices look fine but their text is a scrambled font, for example CareCapital CMS-1500s. Billing mode reads those pages with the built-in OCR automatically, taking about 3 seconds per page. Before reading, it removes the printed red or grey claim form so only the typed values are left. The file then shows a **read with OCR** badge, so check the DOS and totals.
   - If a CMS-1500's box 28 (Total charge) is empty, the total is the sum of the service-line charges in box 24F. The invoice row shows a "!" note when this happens.
   - CMS-1500 amounts printed without a decimal point ("125050") are read as $1,250.50, because the form's dotted line splits off the cents.
   - A CMS-1500's DOS comes only from the service lines (box 24A). Hospitalization dates (box 18) and signature dates are ignored.
   - The patient name and DOB are checked on every file. A mismatch warns you before the PDF is created.
5. **Affidavit blanks**: each blank is detected and filled from the details above.
   - If a blank already has a **wrong** DOS, page count or amount, the old value is whited out and replaced.
   - Blanks made with **underline lines** (Word forms that underline spaces instead of typing "____") are found too. A blank split into pieces ("____ ____") is filled as one.
   - The provider name is printed without "c/o CareCapital".
   - Signature and notary-signature lines stay blank.
   - **Edit by hand (like the Edge PDF viewer):**
     - Click any box on the preview and type straight into it. **Enter** or clicking elsewhere keeps it, **Esc** undoes it.
     - **Add text** (toolbar above the preview): click anywhere on the affidavit and type. **Enter** starts a new line. The small toolbar above the text changes its colour (black / blue / red) and size (A−/A+), and **✕** deletes it. Drag the text to move it, or use the arrow keys (Shift = bigger steps). Click it again to change the words.
     - **Draw**: draw on the page with a pen, for example a tick, a line or a cross. You can pick the colour and thickness. **Erase**: drag over a drawn line to remove it.
     - **Ctrl+Z** takes back the last text or line. **Esc** turns the tool off.
     - If the affidavit page itself was not recognised, it is locked. Tick **All pages**, then press **Edit this page** above it. You'll be asked to confirm, because HIPAA authorizations, letters and other forms must never be edited. **Lock page** undoes it.
   - **Removing pages:** tick **All pages** above the preview and press **Remove page** on any page of the request (press **Undo** to bring it back). For records and invoices, press **Pages** next to the file and click the pages to leave out. The page count, invoice totals and DOS update automatically.
6. **Create & download PDF**. The file name is filled in automatically:
   - Records: `Patient Name_affidavit.pdf`
   - Billing: `Patient Name_bill_affidavit.pdf`
   - Court-case words around the name (Plaintiff, Defendant, Petitioner, Claimant, "et al", "v. …") are left out of the patient name and the file name.

If a request has no affidavit to fill, tick **Add a standard affidavit page**. It adds one of these:
- a records affidavit (Tex. R. Evid. 902(10))
- a billing affidavit (Tex. Civ. Prac. & Rem. Code § 18.001)

## Files
- `Affidavit Filler.html`: the app
- `js/engine.js`: finds and labels blanks, reads the request and invoices, and builds the PDF
- `js/app.js`: the screen and workflow
- `js/ocr.js` + `lib/ocr-core.js` + `lib/ocr-eng-data.js`: offline OCR (Tesseract 5, English). These load only when a scanned PDF needs them.
- `lib/`: pdf.js 3.11 and pdf-lib 1.17, stored locally so the app works offline

## Third-party components
Stored in `lib/` so the tool works offline:
- [pdf.js](https://github.com/mozilla/pdf.js) 3.11 (Apache-2.0)
- [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17 (MIT)
- [tesseract.js-core](https://github.com/naptha/tesseract.js-core) 5 and the Tesseract English data (Apache-2.0)

## Privacy
Everything runs in the browser on your own computer. No PDF, patient name or setting is uploaded anywhere. `.gitignore` keeps PDFs, images, exported settings and zips out of this repository. Never commit patient files.
