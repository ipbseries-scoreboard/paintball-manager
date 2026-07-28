/*
 * CONFIGURAZIONE TURN — QUESTO FILE VA PUBBLICATO INSIEME AL SITO.
 *
 * NON metterlo in .gitignore: i dispositivi che si collegano da fuori (4G)
 * caricano le pagine da GitHub Pages e devono ricevere questa configurazione,
 * altrimenti su alcune reti mobili non riescono a collegarsi alla Regia.
 *
 * ---------------------------------------------------------------------------
 * PERCHE' LA CREDENZIALE QUI DENTRO E' PUBBLICA (e va bene cosi')
 * ---------------------------------------------------------------------------
 * Il TURN e' un server che "rimbalza" il traffico quando due dispositivi non
 * riescono a parlarsi direttamente. Per usarlo, il browser dell'arbitro deve
 * avere la credenziale: quindi qualunque cosa scriviamo qui e' per forza
 * leggibile da chi apre il sito. Non esiste modo di nasconderla senza un
 * server raggiungibile da internet, e il nostro (server.js) gira solo in LAN.
 *
 * La credenziale NON da' accesso ai dati del torneo: apre solo un tunnel di
 * traffico. Il rischio e' che qualcuno consumi la banda dell'account.
 *
 * QUINDI LA PROTEZIONE NON E' NASCONDERLA, MA LIMITARE L'ACCOUNT:
 *
 *   1. Entra nella dashboard di metered.ca con l'account IPBA.
 *   2. RIGENERA le credenziali dell'app. Quelle usate finora erano scritte
 *      dentro pm-client.js, pubblicato su GitHub Pages, quindi vanno
 *      considerate note a chiunque.
 *      -> Rigenerale PRIMA di un evento, mai durante: le vecchie smettono di
 *         funzionare all'istante per tutti.
 *   3. Imposta un tetto di banda mensile (o almeno un avviso di consumo).
 *      Cosi' anche se qualcuno copia le nuove, non puo' prosciugare il piano.
 *   4. Incolla username e credential qui sotto, al posto dei segnaposto,
 *      e ripubblica il sito.
 *
 * ---------------------------------------------------------------------------
 * ALTERNATIVA PER UN SINGOLO PC (senza toccare questo file)
 * ---------------------------------------------------------------------------
 * Dalla console del browser, su quel solo dispositivo:
 *   localStorage.setItem('pm_turn_config', JSON.stringify([
 *     { urls: 'turn:...:80', username: '...', credential: '...' }
 *   ]));
 * Se presente, ha la precedenza su quanto scritto qui.
 *
 * ---------------------------------------------------------------------------
 * FINCHE' I SEGNAPOSTO RESTANO COSI', IL TURN E' SPENTO.
 * Non e' un errore: il programma funziona comunque sempre in LAN, e nella
 * maggior parte dei casi anche da fuori. Mancherebbe solo sulle reti mobili
 * con NAT simmetrico.
 */
window.PM_TURN = [
    { urls: 'turn:global.relay.metered.ca:80', username: '1b33c5f8c4383a8f26a209f4', credential: 'BDpSncyfkZxeg6m8' },
    { urls: 'turn:global.relay.metered.ca:443', username: '1b33c5f8c4383a8f26a209f4', credential: 'BDpSncyfkZxeg6m8' }
];