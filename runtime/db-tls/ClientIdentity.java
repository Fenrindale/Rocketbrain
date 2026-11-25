import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Security;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Enumeration;

// Read one local PKCS#12 client identity or CA-only JKS truststore.
class ClientIdentity {
    public static void main(String[] args) {
        byte[] secret = null;
        byte[] contents = null;
        char[] password = null;
        byte[] keyBytes = null;
        boolean complete = false;
        try {
            var input = new DataInputStream(System.in);
            int secretSize = input.readInt();
            int fileSize = input.readInt();
            if (secretSize < 1 || secretSize > 16384 || fileSize < 1 || fileSize > 2 * 1024 * 1024)
                throw new IllegalArgumentException();
            secret = readExact(input, secretSize);
            contents = readExact(input, fileSize);
            if (input.read() != -1) throw new IllegalArgumentException();
            CharBuffer decoded = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(secret));
            password = new char[decoded.remaining()];
            decoded.get(password);
            if (decoded.hasArray()) Arrays.fill(decoded.array(), '\0');

            Security.setProperty("keystore.type.compat", "false");
            if (args.length == 1 && "jks-trust".equals(args[0])) {
                writeTrustedAuthorities(contents, password);
                complete = true;
                return;
            }
            if (args.length != 0) throw new IllegalArgumentException();
            KeyStore store = KeyStore.getInstance("PKCS12");
            store.load(new ByteArrayInputStream(contents), password);
            String chosen = null;
            Enumeration<String> aliases = store.aliases();
            int aliasCount = 0;
            while (aliases.hasMoreElements()) {
                String alias = aliases.nextElement();
                if (++aliasCount > 32) throw new IllegalArgumentException();
                if (store.entryInstanceOf(alias, KeyStore.PrivateKeyEntry.class)) {
                    if (chosen != null) throw new IllegalArgumentException();
                    chosen = alias;
                }
            }
            if (chosen == null || !(store.getKey(chosen, password) instanceof PrivateKey key))
                throw new IllegalArgumentException();
            String algorithm = key.getAlgorithm();
            if ("EdDSA".equals(algorithm) && key instanceof java.security.interfaces.EdECKey ed)
                algorithm = ed.getParams().getName();
            Certificate[] chain = store.getCertificateChain(chosen);
            if (chain == null || chain.length == 0 || chain.length > 8) throw new IllegalArgumentException();
            keyBytes = key.getEncoded();
            var output = new DataOutputStream(System.out);
            write(output, algorithm.getBytes(StandardCharsets.US_ASCII));
            write(output, keyBytes);
            for (int i = 0; i < chain.length; i++) {
                if (!(chain[i] instanceof X509Certificate certificate)) throw new IllegalArgumentException();
                // Send the leaf and intermediates only. The profile alone controls server trust.
                if (i > 0 && i + 1 == chain.length &&
                        certificate.getSubjectX500Principal().equals(certificate.getIssuerX500Principal())) break;
                write(output, certificate.getEncoded());
            }
            output.flush();
            complete = true;
        } catch (Exception invalid) {
            // Invalid material gets a generic status; no key or password is printed.
        } finally {
            if (secret != null) Arrays.fill(secret, (byte) 0);
            if (contents != null) Arrays.fill(contents, (byte) 0);
            if (password != null) Arrays.fill(password, '\0');
            if (keyBytes != null) Arrays.fill(keyBytes, (byte) 0);
        }
        if (!complete) System.exit(2);
    }

    private static void writeTrustedAuthorities(byte[] contents, char[] password) throws Exception {
        KeyStore store = KeyStore.getInstance("JKS");
        store.load(new ByteArrayInputStream(contents), password);
        if (store.size() == 0 || store.size() > 16) throw new IllegalArgumentException();
        var output = new DataOutputStream(System.out);
        Enumeration<String> aliases = store.aliases();
        while (aliases.hasMoreElements()) {
            String alias = aliases.nextElement();
            if (!store.isCertificateEntry(alias) ||
                    !(store.getCertificate(alias) instanceof X509Certificate certificate) ||
                    certificate.getBasicConstraints() < 0) throw new IllegalArgumentException();
            boolean[] usage = certificate.getKeyUsage();
            if (usage != null && (usage.length <= 5 || !usage[5])) throw new IllegalArgumentException();
            certificate.checkValidity();
            write(output, certificate.getEncoded());
        }
        output.flush();
    }

    private static byte[] readExact(DataInputStream input, int size) throws Exception {
        byte[] data = input.readNBytes(size);
        if (data.length != size) throw new IllegalArgumentException();
        return data;
    }

    private static void write(DataOutputStream output, byte[] data) throws Exception {
        if (data == null || data.length == 0 || data.length > 131072) throw new IllegalArgumentException();
        output.writeInt(data.length);
        output.write(data);
    }
}
