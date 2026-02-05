# Soundcloud Playlist Prettier Single

Toma un archivo de texto con datos de un playlist y genera un playlist limpio y formateado.

## tl;dr

1. Crea un archivo llamado `entrada.txt` dentro de `soundcloud-playlist-prettier-single/`. Puedes usar entrada.ejemplo.txt, crear una copia y llenar con datos nuevos.
2. Pega en ese archivo, en cualquier orden, la URL (línea que empieza con `http`), el título (líneas que empiezan con `Euphonic Sessions ...`) y las líneas del playlist (líneas que empiezan con números 01,02,...).
3. Ejecuta:

```bash
cd soundcloud-playlist-prettier-single
node index.js entrada.txt
# o para guardar en archivo:
node index.js entrada.txt salida.txt
```

El script buscará `entrada.txt` por defecto si no especificas otro archivo de entrada.

## Formato de Entrada

El archivo de entrada debe contener:
- **Primera línea no vacía**: URL de SoundCloud
- **Segunda línea no vacía**: Título del playlist
- **Líneas siguientes**: Pistas del playlist

### Ejemplo de entrada

```
https://soundcloud.com/euphonicsessions/euphonic-sessions-february2026

Euphonic Sessions with Kyau & Albert - February 2026



01 LAR, Keepa - Insomniac [Colorize]
02 Máximo Lasso - I Really Wonder About Tomorrow [Euphonic Visions]
03 Trilucid - Let Go of Your Pain [Anjunadeep Explorations]
04 Rospy x Nestora - This Life [Elliptical Sun]
05 Oliver Smith & Benjamin Roustaing - Be The One (Meramek Mix) [Anjunabeats]
06 Kyau & Albert - Unforgivable [Euphonic]
07 EBENEZER - Heaven [A State Of Trance]
08 John Grand - Let Go [Euphonic]
09 Estiva - Désir [Colorize] [TRACK OF THE MONTH]
10 Hit - Through The Haze (Bunched Remix) [Seveneves.de Records]
```

## Formato de Salida

El script genera un playlist formateado con:
- Título y URL del playlist
- Números de pista con punto (01., 02., etc.)
- Títulos de canciones entre comillas
- Remixes en paréntesis fuera de las comillas
- Etiquetas especiales ([TRACK OF THE MONTH], etc.) en líneas separadas

### Ejemplo de salida

```
Euphonic Sessions with Kyau & Albert - February 2026
https://soundcloud.com/euphonicsessions/euphonic-sessions-february2026

01. LAR, Keepa - "Insomniac" [Colorize]
02. Máximo Lasso - "I Really Wonder About Tomorrow" [Euphonic Visions]
03. Trilucid - "Let Go of Your Pain" [Anjunadeep Explorations]
04. Rospy x Nestora - "This Life" [Elliptical Sun]
05. Oliver Smith & Benjamin Roustaing - "Be The One" (Meramek Mix) [Anjunabeats]
06. Kyau & Albert - "Unforgivable" [Euphonic]
07. EBENEZER - "Heaven" [A State Of Trance]
08. John Grand - "Let Go" [Euphonic]

[TRACK OF THE MONTH]
09. Estiva - "Désir" [Colorize]

10. Hit - "Through The Haze" (Bunched Remix) [Seveneves.de Records]
```

## Uso

### Mostrar en consola

```bash
node index.js <archivo-entrada>
```

Ejemplo:
```bash
node index.js test-input.txt
```

### Guardar a archivo

```bash
node index.js <archivo-entrada> <archivo-salida>
```

Ejemplo:
```bash
node index.js test-input.txt output.txt
```

## Instalación

```bash
cd soundcloud-playlist-prettier-single
npm install
```

## Características

- Normaliza espacios alrededor de guiones
- Corrige errores comunes de ortografía en etiquetas
- Convierte "ft" a "ft."
- Detecta automáticamente remixes y los coloca fuera de las comillas
- Mueve etiquetas especiales a líneas separadas para mayor legibilidad
- Aplica correcciones desde el archivo `corrections.json` compartido
