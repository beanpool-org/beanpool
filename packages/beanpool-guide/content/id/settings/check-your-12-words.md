---
slug: check-your-12-words
title: 12 katamu dan kunci server (pemilik)
summary: Untuk pemilik komunitas. Memeriksa 12 katamu, mengambil alih atau memulihkan server dengan ponselmu, dan pemeriksaan otomatis oleh ponsel.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## Untuk siapa panduan ini

Hanya untuk **pemilik** komunitas. Jika kamu bukan seorang pemilik, kamu tidak akan melihat semua ini.

## Mengapa pemilik diminta melakukannya

Server komunitasmu menyimpan salinan terkunci dari kunci-kuncinya, untuk memindahkan komunitas ke server lain jika server aslinya hilang, dan cadangannya juga terkunci. Kunci-kunci tersebut dikunci ke akun para pemilik: pemilik mana pun dapat membukanya dengan ponsel mereka (lihat Mengambil alih atau memulihkan dengan ponselmu, di bawah). Jika kamu kehilangan ponselmu, 12 katamu akan memulihkan akunmu, dan bersamanya kunci untuk membuka gembok server serta cadangannya. Hal tersebut paling penting pada saat server itu sendiri hilang.

Oleh karena itu, aplikasi meminta setiap pemilik, dari waktu ke waktu, untuk memeriksa apakah mereka masih memiliki 12 kata yang benar. Kamu dapat memilih **Nanti**. Tidak ada yang pernah diblokir, dan kamu dapat terus melakukan semua hal yang dilakukan seorang pemilik.

## Kapan aplikasi meminta

- Sekali, tidak lama setelah kamu menjadi pemilik.
- Kembali 12 bulan setelah pemeriksaan terakhirmu.

Aplikasi menampilkan kartu di bagian atas Pasar (di aplikasi web, di bagian atas setiap layar kecuali Peta): **Periksa sekarang** atau **Nanti**. **Nanti** akan menyingkirkan kartu tersebut sampai waktu jatuh tempo berikutnya. Kamu dapat memeriksa kapan saja dari **Pengaturan**: di bawah **KUNCI KOMUNITAS**, ketuk **Periksa 12 katamu** (di aplikasi web, **Periksa sekarang**).

## Cara memeriksa

- Siapkan kertasmu yang berisi 12 kata tersebut.
- Ketik kata-kata tersebut secara berurutan, dengan spasi di antaranya. Huruf besar dan spasi ekstra tidak berpengaruh.
- Ketuk **Periksa kataku**.

Jika benar, aplikasi akan menampilkan **Ini adalah kata-kata yang benar**. Jika tidak: **Ini bukan kata-kata untuk akun ini.**. Aplikasi tidak menyebutkan kata mana yang salah, jadi periksa kertasmu dan ketik ulang semuanya.

Pada ponsel tanpa salinan 12 katamu (ponsel yang dipulihkan dengan akun masuk), kata-kata yang benar juga menampilkan **Simpan di ponsel ini**. Ketuk tombol tersebut dan **Lihat Frasa Pemulihan** akan menampilkannya sejak saat itu. Ini adalah pemeriksaan yang sama dan penyimpanan yang sama dengan **Tambahkan 12 katamu ke ponsel ini** (lihat "12 kata Anda").

Tidak dapat menemukannya? Jika ponsel ini masih menyimpannya, **Pengaturan**, lalu **Lihat Frasa Pemulihan**, akan menampilkannya. Tuliskan kembali, lalu periksa. Pada ponsel tanpa salinan, aplikasi akan memberitahukan hal itu: ketika kamu menemukannya, periksa di sini, lalu simpan.

## Apa yang dikirim, dan apa yang tidak

- Pemeriksaan dilakukan di ponselmu (atau di browsermu, pada aplikasi web). Kata-katamu tidak pernah dikirim ke mana pun. Kotak input segera dikosongkan begitu pemeriksaan selesai, dan saat kamu meninggalkan layar. Kata-kata tersebut hanya disimpan jika kamu mengetuk **Simpan di ponsel ini**, dan hanya di ponsel ini saja.
- Ketika kata-katanya benar, ponselmu hanya memberi tahu server komunitasmu bahwa kamu telah memeriksa, dan kapan, yang ditandatangani dengan akunmu.
- Pemilik dan admin melihat, di Pengaturan server, tanggal "12 kata diperiksa" milik masing-masing pemilik, atau "belum". Itu adalah pernyataanmu sendiri: server tidak dapat melihat atau memeriksa kata-katamu.

## Mengambil alih atau memulihkan dengan ponselmu

Jika server komunitasmu hilang, siapa pun yang menjalankan server siaga (atau server baru yang memulihkan cadangan) dapat meminta pemilik untuk membuka kunci-kunci yang terkunci. Salah satu pemilik saja sudah cukup. Kamu memerlukan versi terbaru aplikasi BeanPool. Aplikasi web juga berfungsi jika masih bisa dibuka, tetapi aplikasi web berada di alamat komunitasmu sendiri, yang mungkin ikut mati bersama server: aplikasi ponsel adalah yang paling bisa diandalkan.

- Pada Pengaturan server, mereka memilih **Take over as the main server**, lalu **I understand: use an owner's phone**, atau **Open with an owner's phone** saat memulihkan cadangan. Sebuah kode akan muncul di layar mereka.
- Di aplikasi: **Pengaturan**, di bawah **KUNCI KOMUNITAS**, ketuk **Ambil alih atau pulihkan dengan ponsel ini**, dan arahkan kamera ke kode tersebut. Jika halaman server terbuka di ponselmu sendiri, mengetuk tautannya melakukan hal yang sama. Di aplikasi web, salin tautan dari layar mereka dan tempelkan di bawah **Ambil alih atau pulihkan dengan browser ini** di **Pengaturan**.
- Aplikasi menunjukkan komunitas mana, server mana, dan apa yang akan terjadi. Jika server utamamu masih merespons, aplikasi menyatakannya dalam warna merah: pengambilalihan hanya untuk server yang benar-benar hilang.
- Ketuk **Buka kunci untuk pengambilalihan** (atau **Buka kunci cadangan**). Ponselmu meminta pembukaan kuncinya sendiri terlebih dahulu: sidik jari, wajah, atau PIN. Aplikasi web tidak memiliki langkah seperti ini, itulah sebabnya aplikasi ponsel adalah tempat yang lebih aman untuk kunci pemilik.
- Ponselmu membuka bagian kuncinya sendiri dan menyerahkan kunci tersebut ke server tersebut, terkunci sehingga hanya server tersebut yang dapat membacanya. Ponselmu tidak pernah melihat kunci server atau cadangannya.
- Pada pengambilalihan, orang di server kemudian mengonfirmasi di layar mereka. Komunitas diberi tahu bahwa server telah dipindahkan, dan bahwa kamu yang telah membuka kunci-kuncinya.

Aplikasi menolak, dan menjelaskan alasannya, jika gembok tersebut milik komunitas lain, jika gembok tidak dikunci untukmu, jika kode server telah kedaluwarsa (kode berlaku 10 menit dan hanya berfungsi sekali), atau jika kuncinya tidak dikunci oleh server komunitasmu sendiri.

## Ponselmu memeriksa gembok secara otomatis

Setiap kali gembok komunitasmu berubah (pemilik ditambahkan atau dihapus, kode pemulihan baru dibuat), aplikasimu memeriksa, secara diam-diam, apakah ia masih dapat membuka bagian kuncinya. Aplikasi membukanya, langsung membuang kunci tersebut, dan memberi tahu server apakah pemeriksaan berhasil. Tidak ada yang diminta darimu.

Pemilik dan admin melihatnya di Pengaturan server, di sebelah tanggal 12 katamu: **their phone opened the current lock**, bersama tanggalnya, atau bahwa ponsel terakhir kali membuka kunci yang lebih lama. Jika dinyatakan bahwa ponselmu **could NOT open** gembok tersebut, periksa 12 katamu, dan minta pemilik lain untuk memeriksa Pengaturan server.
