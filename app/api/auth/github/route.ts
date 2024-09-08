import { github, lucia } from "@/lib/auth";
import { cookies } from "next/headers";
import { OAuth2RequestError } from "arctic";
import { generateIdFromEntropySize } from "lucia";
import { encrypt } from "@/lib/crypto";
import { db } from "@/db";
import { userTable, githubUserTokenTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const storedState = cookies().get("github_oauth_state")?.value ?? null;
	if (!code || !state || !storedState || state !== storedState) {
		return new Response(null, {
			status: 400
		});
	}

	try {
    const token = await github.validateAuthorizationCode(code);
		const githubUserResponse = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token.accessToken}`
			}
		});
		const githubUser: GitHubUser = await githubUserResponse.json();
    
    const { ciphertext, iv } = await encrypt(token.accessToken);

		const existingUser = await db.query.userTable.findFirst({ where: eq(userTable.githubId, Number(githubUser.id)) });

		if (existingUser) {
			await db.update(githubUserTokenTable).set({ ciphertext, iv }).where(eq(githubUserTokenTable.userId, existingUser.id));
			const session = await lucia.createSession(existingUser.id as string, {});
			const sessionCookie = lucia.createSessionCookie(session.id);
			cookies().set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
			return new Response(null, {
				status: 302,
				headers: {
					Location: "/"
				}
			});
		}

		const userId = generateIdFromEntropySize(10); // 16 characters long

		await db.insert(userTable).values({
			id: userId,
			githubId: Number(githubUser.id),
			githubUsername: githubUser.login,
			githubEmail: githubUser.email,
			githubName: githubUser.name
		});
    await db.insert(githubUserTokenTable).values({ ciphertext, iv, userId });

		const session = await lucia.createSession(userId, {});
		const sessionCookie = lucia.createSessionCookie(session.id);
		cookies().set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
		return new Response(null, {
			status: 302,
			headers: {
				Location: "/"
			}
		});
	} catch (e) {		
    console.error(`GET /api/auth/github/route.ts error: `, e);
    // the specific error message depends on the provider
    let statusText = "Unknown error";
    let status = 500;
    if (e instanceof OAuth2RequestError) {
      // invalid code
      statusText = e.description || "Unknown OAuth2 error";
      status = 400;
    } else if (e instanceof Error) {
      statusText = e.message;
    }
    return new Response(statusText, {
      status,
      statusText,
    });
  }
}

interface GitHubUser {
	id: string;
	login: string;
	email: string;
	name: string;
}