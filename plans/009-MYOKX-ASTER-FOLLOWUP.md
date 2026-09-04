# 009 — MyOKX / Aster: enger Folgebeleg

Stand: 2026-09-03; Basis `f8089277d0667dd45bcf070037800d423fd89254` plus die
vorhandenen uncommitteten Reparaturen. Python 3.12.13, installiertes CCXT 4.5.75.
Keine Provider-/Kontozugriffe, keine Source-/SDK-/Profil-/Manifeständerungen.
Implementierungs- und Providerabnahme bleiben unbewiesen.

## Entscheidung und kleinste Grenze

| Geprüfter Slice | Entscheidung / konkrete Grenze |
|---|---|
| MyOKX, dokumentierte EEA-Laufzeit-X-Perps | `not_easy`: echte Expiry und Cash-Settlement benötigen den größeren gemeinsamen Produkt-/Ablauf-Lifecycle; kein Swap-Flag-Fix. |
| MyOKX, nativer Attached-IOC im vorhandenen TSX-Zwei-Leg-Vertrag | `not_easy`: bei einem terminalen Zero-Fill-Parent kann das bedingte Kind nie erzeugt werden. TSX besitzt keinen originalgebundenen `not_created`-Nachweis für ein gemeinsam bereits gesendetes Journal. Ein Serializer kann das nicht durch eine erfundene Child-ID lösen. |
| Tatsächliches zusätzliches regionales Perp-Angebot / konkreter Accountscope | Nicht belegt. Die synthetische Swap-Fixture behauptet kein angebotenes Instrument; geerbte Methoden und generische API-Aufzählungen schließen diese Beweislücke nicht. |
| Aster V3, bisher vorgeschlagener Crypto-USDT-Perp-Slice | Weiter `pending`: accountweiter Scope unbekannter wartender Strategie-Parents/-Children ist unbelegt. Keine technische Unmöglichkeit aus fehlender Dokumentation ableiten. |

Bei MyOKX sind die größeren Lifecyclegrenzen unabhängig von der REST/Pro-
Deklarationsabweichung. Diese Abweichung allein ist **kein** Ausschlussgrund.
Die kleinste weiterhin nötige Aster-Klärung bleibt eine vollständige
Accountliste einschließlich wartender Strategien oder ein authentifiziert
lesbarer Produktausschluss. Ein entsprechender Reader wäre klein implementierbar;
ohne Quellenvertrag wird keine erfolgreiche Leersicht erzeugt.

## Echte SDK-Beziehung und permanenter Nachweis

Neue Datei: `exchange_executor/tests/test_additional_myokx_boundaries.py`.

1. REST erbt `async_support.okx`; Pro erbt `pro.okx → async_support.okx`, **nicht**
   `async_support.myokx`. Neun REST-Funktionen einschließlich Builder, Batch,
   Parser, Einzel-/Open-Order, Cancel, Fills und Marktloader sowie die drei
   Pro-Watchmethoden werden als identische Funktionsobjekte geprüft.
2. Tatsächlich ausgeführte Loaderplanung: REST `mica=true`, `spot/swap`,
   `swap=true`; Pro `mica=null`, `spot/future/swap/option`, `swap=false`.
   Die Loader-Ergebnisse sind ausdrücklich leere lokale Fakes, keine Marktbelege.
3. Echter SDK-Serializer und echte HMAC-Signatur: genau ein abgefangener POST an
   `https://eea.okx.com/api/v5/trade/batch-orders`, IOC mit Preis `100.5`, Größe
   `2`, ursprünglicher Parent-Client-ID und genau einem unveränderten Attached-SL
   (`slTriggerPx=90`, `slOrdPx=-1`, eigene `attachAlgoClOrdId`). Die Signatur wird
   unabhängig über die tatsächlichen Header-/Bodybytes nachgerechnet. Credentials
   sind ausschließlich synthetische In-memory-Testwerte und werden nicht geloggt.
   Der echte ACK-Parser erhält genau eine Parent-ID, keine Child-ID; Status bleibt
   unbekannt. Ein Placement-ACK beweist weder Fill noch Zero-Fill-Terminalität.
4. Echter REST- und Pro-Marktparser erhält bei einer synthetischen nativen
   `FUTURES`-/`ruleType=xperp`-Zeile die Originalexpiry und `future=true`,
   `swap=false`. Originalrequest, Markt und ACK bleiben unverändert.

Alle nicht spezifizierten SDK-Transporte sowie Socket-Verbindung und DNS werden
fail-closed gesperrt. Windows' interner Event-loop-Socketpair wird vor dieser
Testblockade erstellt; die Blockade wird nicht als OS-Sandbox ausgegeben.

## Primärquellen und gemeinsame Lifecyclegrenze

- [Regionale EEA-API](https://my.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order),
  gelesen 2026-09-03: EEA-Hosts, IOC, Attached-SL und spätere Übernahme der
  Attached-Client-ID in die echte Algo-Client-ID. Im Historyvertrag bleibt
  `attachAlgoId` von `algoId` getrennt. Diese regionale Quelle belegt die relevante
  Identitätstrennung selbst, nicht lediglich die gemeinsame Marke.
- [Globale Änderung vom 1. Juli 2026](https://www.okx.com/help/okx-announcement-on-optimizing-order-placement-for-order-attached-take):
  Schutz nach Teilfill plus Restcancel; die regionale API nennt weiterhin
  vollständigen Fill. Keine ungeprüfte regionale Gleichsetzung dieser Regel.
  Die Zero-Fill-/nie-erzeugtes-Kind-Grenze bleibt in beiden Fällen bestehen.
- [EEA-X-Perp-Spezifikation](https://www.okx.com/en-sg/help/x-perps-contract-specifications):
  feste Laufzeiten, Endtermine und Cash-Settlement. Keine Ableitung eines
  tatsächlich verfügbaren unbefristeten Perps aus dem Produktnamen.
- [Aster V3 Account/Trading](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/):
  `openOrders` kann normale Orders aller Symbole liefern. `strategyOpenOrder`
  und `strategyHistoryOrder` verlangen bekannte Strategie-IDs; die gelesene
  Quelle liefert keinen ausdrücklichen vollständigen Scope wartender Strategien.
  Die vorhandene `009-ASTER-BITMEX-RESEARCH.md` bleibt maßgeblich; bereits fertige
  Aster-Batch-/Nonce-/Moneyproben wurden hier nicht neu ausgeführt.

Aktuell direkt nachgelesener TSX-Vertrag: `exchange_contract_validation.ts:55`
verlangt echte Order-IDs; `trading_recovery.ts:238` verlangt positive Belege aller
erwarteten Legs; `trading_engine.ts:2068` verweigert Closure unbekannter
Exit-Geschwister. `retireUndispatchedExit` gilt nur für belegtes lokales Nicht-
Dispatching. Die beiden MyOKX-Lifecycleerweiterungen sind daher kein freigegebener
kleiner Providerhelper. Keine nicht erzeugte Kindorder als Cancel/Reject erfinden.

## Geprüfte SDK-Dateihashes

Relativ zu `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/`:

| Datei | SHA-256 |
|---|---|
| `async_support/myokx.py` | `4d8f2ed6d290f06e2c6d588514d2976f1cec39ef9069c987e20d78b394066dfb` |
| `async_support/okx.py` | `470fda8880a1170b576dd6911fccb349bb95bd5847a277a11b98f7bbb4e85665` |
| `pro/myokx.py` | `a73299aefa74b45396813cdae011e45665b8ff5d8c12588af533f2b2c9f8d5ac` |
| `pro/okx.py` | `82c27ec2e4609005e0c29e1b0caa683a5c6d0a4ceb73259646e150816fb9f7c5` |
| `async_support/aster.py` | `df0bac5adcc10033bebf3b8a7e03f4cef856ee4a1ea5e2a60867800f8b86b9b7` |

## Ausgeführte Prüfung

Vom Repository-Root:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_additional_myokx_boundaries.py
& 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe' check exchange_executor/tests/test_additional_myokx_boundaries.py
```

Ergebnis: **4/4 Tests, 1,363 s, Exit 0; Ruff Exit 0.** Kein Gesamtlauf und keine
neue Profilparitäts-/Providerfreigabe. Assessmentänderung ausschließlich durch
Root nach eigenständigem Lesen dieser Belege.
