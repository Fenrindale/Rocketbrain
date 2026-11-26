'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const version = '4.2.13';
const execute = promisify(execFile);

const SOURCE = String.raw`
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.HexFormat;

public final class RocketbrainScalaLoopback implements ClassFileTransformer {
    private static final String TARGET = "ch/epfl/scala/debugadapter/DebugServer$Address";
    private static final String SHA256 = "f88d17ff91e4a855ecbf0c6b334ddfc528b8bdbbd297263592531e0ee9f98da3";
    private static final ClassDesc SOCKET_ADDRESS = ClassDesc.of("java.net.InetSocketAddress");

    public static void premain(String ignored, Instrumentation instrumentation) {
        instrumentation.addTransformer(new RocketbrainScalaLoopback());
    }

    @Override public byte[] transform(ClassLoader loader, String name, Class<?> previous,
                                       ProtectionDomain domain, byte[] bytes) {
        if (!TARGET.equals(name)) return null;
        try {
            var digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!SHA256.equals(digest)) return refused();
            var api = ClassFile.of();
            int[] patched = {0};
            var update = ClassTransform.transformingMethodBodies(
                method -> method.methodName().equalsString("<init>"),
                (code, element) -> {
                    if (element instanceof InvokeInstruction call
                            && call.owner().asInternalName().equals("java/net/InetSocketAddress")
                            && call.name().equalsString("<init>") && call.type().equalsString("(I)V")) {
                        code.pop().ldc("127.0.0.1").iconst_0().invokespecial(
                            SOCKET_ADDRESS, "<init>", MethodTypeDesc.ofDescriptor("(Ljava/lang/String;I)V"));
                        patched[0]++;
                    } else {
                        code.with(element);
                    }
                });
            var result = api.transformClass(api.parse(bytes), update);
            return patched[0] == 1 && api.verify(result).isEmpty() ? result : refused();
        } catch (Exception | LinkageError error) {
            return refused();
        }
    }

    private static byte[] refused() {
        System.err.println("Rocketbrain Scala stopped an unsupported debug adapter before it could open a listener.");
        // Instrumentation ignores transformer exceptions. Reject class loading instead.
        return new byte[1];
    }
}
`;

async function buildLoopbackAgent(javaBin, env) {
  const folder = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-scala-loopback-'));
  const source = path.join(folder, 'RocketbrainScalaLoopback.java');
  const manifest = path.join(folder, 'manifest.mf');
  const jar = path.join(folder, 'rocketbrain-scala-loopback.jar');
  const tool = name => path.join(javaBin, name + (process.platform === 'win32' ? '.exe' : ''));
  const options = { cwd: folder, env, windowsHide: true, timeout: 25000, maxBuffer: 65536 };
  const dispose = () => fs.rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  try {
    await fs.writeFile(source, SOURCE, { flag: 'wx' });
    await fs.writeFile(manifest, 'Manifest-Version: 1.0\nPremain-Class: RocketbrainScalaLoopback\n\n', { flag: 'wx' });
    await execute(tool('javac'), ['--release', '25', '-encoding', 'UTF-8', source], options);
    await execute(tool('jar'), ['--create', '--file', jar, '--manifest', manifest,
      '-C', folder, 'RocketbrainScalaLoopback.class'], options);
    return { jar, dispose };
  } catch (error) {
    await dispose();
    throw new Error('Could not build the Scala debugger loopback guard with the configured JDK 25.', { cause: error });
  }
}

module.exports = { buildLoopbackAgent, version };
